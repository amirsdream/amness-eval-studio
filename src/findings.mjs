// Harness checks: what each run says about the agent's harness (Amness), not only about the model. Every run, live or finished, is read for
// patterns that point at a harness bug or at friction the harness could remove, so each campaign also gives continuous feedback on Amness itself.
// A check is { id, kind, title, why }; a finding is one check that fired on one run, with the evidence (step and text) that made it fire.
// Kinds: "bug" (the harness did something wrong), "friction" (the harness made the work harder than needed), "model" (the model's behaviour), "info".
import { existsSync } from "node:fs";
import { join } from "node:path";
import { jobView, trialDir } from "./live.mjs";

export const CHECKS = {
  "cwd-guess": { kind: "friction", title: "Guessed a working directory", why: "A command changed into a folder that does not exist (often /home/user): the system prompt should name the working directory." },
  "read-cut": { kind: "friction", title: "A file read was cut", why: "A file's text was shortened before the model saw it. For a small file the cap is too tight, and the model reads again in pieces." },
  "reread-nothing-new": { kind: "bug", title: "A re-read delivered nothing new", why: "The model read a file again and got only markers and cuts: lines it never saw could not reach it." },
  "tool-error": { kind: "friction", title: "A harness tool failed", why: "One of the harness's own tools (not a shell command) returned an error. Read the message: is it clear, and did the model recover?" },
  "batch-rejected": { kind: "friction", title: "A whole edit batch was refused", why: "One edit of a multi-edit call did not match, so none were applied; the model has to redo all of them." },
  "patch-mismatch": { kind: "friction", title: "A patch did not apply", why: "apply_patch could not find the lines to replace. Does the error name the line that differs?" },
  "long-thinking": { kind: "model", title: "Very long thinking in one request", why: "The model thought for more than ~6,000 tokens in one request. On a slow server that is minutes: consider a thinking budget." },
  "think-no-act": { kind: "friction", title: "Long thinking again and again, no edit", why: "The model thought at length on several steps but changed nothing: it may be working out the same analysis again each time (is its earlier thinking kept?)." },
  "time-out-thinking": { kind: "friction", title: "Time ran out while the model was thinking", why: "The run hit its time limit in the middle of a model request: the work of that request is lost, and its tokens are not counted." },
  "timeout": { kind: "info", title: "Stopped at the time limit", why: "The run ended because its time was up." },
  "claimed-done-failed": { kind: "model", title: "Finished, but the tests failed", why: "The agent called finish, yet the task's tests failed: the harness's checks before finishing did not catch it." },
  "no-test-run": { kind: "info", title: "Finished without running a test", why: "The audit noted that no test command was run before finishing." },
  "guard": { kind: "info", title: "Guard actions", why: "The harness nudged, refused or steered the model. Were they needed?" },
  "no-result-line": { kind: "bug", title: "No result line", why: "The agent's log has no final result line: it crashed or was killed before it could report." },
  "stderr": { kind: "bug", title: "Errors on the agent's error output", why: "The agent wrote an error or warning to stderr." },
};

const finished = new Map();   // job -> findings, for runs that have ended (they do not change any more)
const clip = (s, n = 220) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };

/** The findings of one run, from its conversation (see live.mjs) and its result. */
export function findings(job, view = null) {
  if (finished.has(job)) return finished.get(job);
  const v = view ?? jobView(job, 0), items = v.items ?? [], out = [];
  const add = (id, evidence, step = null) => { const f = out.find((x) => x.id === id); if (f) { f.count++; if (f.evidence.length < 4) f.evidence.push({ step, text: clip(evidence) }); } else out.push({ id, ...CHECKS[id], count: 1, evidence: [{ step, text: clip(evidence) }] }); };
  let step = null; const reads = new Map();
  for (const it of items) {
    if (it.t === "step") step = it.step + 1;
    if (it.t === "thinking" && it.text.length > 24_000) add("long-thinking", `${Math.round(it.text.length / 4).toLocaleString("en-US")} tokens of thinking (about ${Math.round(it.text.length / 4 / 36 / 60)} min at 36 tokens/s)`, step);
    if (it.t === "guard" && it.name !== "aborted") add("guard", `${it.name}: ${it.text}`, step);
    if (it.t === "audit" && it.notes?.some((n) => /no test command/.test(n))) add("no-test-run", it.notes.join("; "), step);
    if (it.t !== "tool" || it.result === null || it.result === undefined) continue;
    const r = String(it.result), a = it.args && typeof it.args === "object" ? it.args : {};
    if ((it.name === "sh" || it.name === "bash") && /\bcd\s+\S+/.test(a.cmd ?? "") && /cd: .*No such file or directory/.test(r)) add("cwd-guess", a.cmd, step);
    if (it.name === "read_file") {
      const p = a.path ?? "", sawBefore = reads.has(p), newLines = r.split("\n").filter((l) => /^\d+\t/.test(l)).length;
      if (/chars cut/.test(r)) add("read-cut", `${p}${a.start ? ` lines ${a.start}-${a.end ?? "end"}` : ""}: ${/\[(\d+) chars cut/.exec(r)?.[1] ?? "?"} characters cut`, step);
      if (sawBefore && newLines === 0 && /unchanged: already above/.test(r) && /chars cut/.test(r)) add("reread-nothing-new", `${p}: ${clip(r, 160)}`, step);
      reads.set(p, true);
    }
    if (/^ERROR/.test(r) && it.name !== "sh" && it.name !== "bash") {
      if (/^ERROR: edit \d+ of \d+/.test(r)) add("batch-rejected", `${it.name}: ${r}`, step);
      else if (it.name === "apply_patch") add("patch-mismatch", r, step);
      else if (!/escapes the workspace/.test(r)) add("tool-error", `${it.name}: ${r}`, step);
    }
  }
  const longThinks = items.filter((x) => x.t === "thinking" && x.text.length > 12_000).length, edits = items.filter((x) => x.t === "edit").length;
  if (longThinks >= 3 && edits === 0) add("think-no-act", `${longThinks} requests with more than ~3,000 tokens of thinking each, and no file changed`);
  const end = items.find((x) => x.t === "end"), lastModelItem = [...items].reverse().find((x) => x.t !== "end" && x.t !== "guard");
  if (end && end.stopped === "time") { add("timeout", end.text); if (lastModelItem?.t === "thinking" || lastModelItem?.t === "step") add("time-out-thinking", `the last request was still running (${Math.round((lastModelItem.text?.length ?? 0) / 4).toLocaleString("en-US")} tokens of thinking so far)`); }
  if (end?.finished && v.reward !== null && v.reward !== undefined && v.reward < 1) add("claimed-done-failed", `finish: ${clip(items.find((x) => x.t === "finish")?.text ?? end.text, 180)}`);
  const done = v.phase === "done";
  if (done && items.length && !end && !v.exception) add("no-result-line", "the log ends without a result line");
  if (v.stderr && /error|warn|exception|traceback/i.test(v.stderr)) add("stderr", v.stderr.split("\n").filter((l) => /error|warn|exception|traceback/i.test(l)).slice(0, 2).join(" | "));
  const order = { bug: 0, friction: 1, model: 2, info: 3 };
  out.sort((a, b) => order[a.kind] - order[b.kind] || b.count - a.count);
  const t = trialDir(job);
  if (done && t && existsSync(join(t, "result.json"))) finished.set(job, out);
  return out;
}

/** Every check that fired in a campaign: how many runs, how often, and which runs (for links). */
export function campaignFindings(results) {
  const by = new Map();
  for (const r of results) {
    let fs = []; try { fs = findings(r.job); } catch { continue; }
    for (const f of fs) {
      const e = by.get(f.id) ?? { id: f.id, ...CHECKS[f.id], runs: [], count: 0, example: f.evidence[0] };
      e.count += f.count; e.runs.push({ job: r.job, task: r.task, variant: r.variant, trial: r.trial, count: f.count, passed: r.reward >= 1 }); by.set(f.id, e);
    }
  }
  const order = { bug: 0, friction: 1, model: 2, info: 3 };
  return [...by.values()].sort((a, b) => order[a.kind] - order[b.kind] || b.runs.length - a.runs.length);
}
