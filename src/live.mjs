// What a Harbor job is doing right now, read from its folder: the phase (setting up, the agent working, the tests running, done), timings,
// the agent's conversation so far (from Amness's --json log, read incrementally), and the tests' output when they ran.
//
// The conversation is a list of items (system prompt, task, step, thinking, text, tool call, edit, guard action, audit, finish, end). Items change
// while they stream (thinking grows, a tool call gets its result), so each carries `seq`, the change counter when it last changed: a client that
// has seen up to seq N asks for the items with seq > N and replaces them by index.
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./campaign.mjs";

const cache = new Map();   // job -> the parsed log so far
const MAX_TEXT = 40_000;   // per item: a tool's output or a diff can be huge
const clip = (x, n = MAX_TEXT) => { const t = typeof x === "string" ? x : x === undefined || x === null ? "" : JSON.stringify(x, null, 2); return t.length > n ? t.slice(0, n) + `\n… (${t.length - n} more characters)` : t; };
const GUARDS = new Set(["nudge", "rejected", "denied", "loop", "rollover", "budget", "aborted", "repair"]);

export function trialDir(job) {
  const jd = join(paths.jobs, job);
  if (!/^[\w.-]+$/.test(job) || !existsSync(jd)) return null;
  const t = readdirSync(jd).find((d) => { try { return statSync(join(jd, d)).isDirectory(); } catch { return false; } });
  return t ? join(jd, t) : null;
}

const fresh = () => ({ size: 0, rest: "", seq: 0, items: [], tools: new Map(), steps: new Map(), open: { thinking: null, text: null }, modelText: false,
  usage: { requests: 0, prompt: 0, cached: 0, completion: 0, reasoning: 0, perRequest: [] }, step: null, max: null, agentPhase: null, result: null });

function add(c, item) { item.i = c.items.length; item.seq = ++c.seq; c.items.push(item); return item; }
function touch(c, item) { item.seq = ++c.seq; return item; }
function content(m) { return typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p) => p.text ?? (p.type ? `[${p.type}]` : "")).join("\n") : ""; }
function args(a) { try { return typeof a === "string" ? JSON.parse(a) : a ?? {}; } catch { return a; } }

/** Fold one event of `amness run --json` into the conversation. */
function fold(c, e) {
  switch (e.kind) {
    case "run": for (const m of e.messages ?? []) add(c, { t: m.role === "system" ? "system" : "user", text: clip(content(m)) }); break;
    case "phase":
      c.agentPhase = e.phase; c.max = e.max ?? c.max;
      if (e.phase === "model" && !c.steps.has(e.step)) { c.steps.set(e.step, add(c, { t: "step", step: e.step, max: e.max ?? null, usage: null })); c.open = { thinking: null, text: null }; c.modelText = false; }
      break;
    case "thinking": case "text": {
      const k = e.kind, o = c.open[k] ?? (c.open[k] = add(c, { t: k, text: "", live: true }));
      if (o.text.length < MAX_TEXT) o.text += e.delta ?? ""; touch(c, o); break;
    }
    case "model": {
      const m = e.message ?? {}, text = content(m);
      if (c.open.thinking) { c.open.thinking.live = false; touch(c, c.open.thinking); }
      if (c.open.text) { c.open.text.live = false; if (text) c.open.text.text = clip(text); touch(c, c.open.text); } else if (text.trim()) add(c, { t: "text", text: clip(text) });
      c.modelText = !!text.trim(); c.open = { thinking: null, text: null };
      for (const tc of m.tool_calls ?? []) if (!c.tools.has(tc.id)) c.tools.set(tc.id, add(c, { t: "tool", id: tc.id, name: tc.function?.name, args: args(tc.function?.arguments), status: "planned", result: null, error: false }));
      break;
    }
    case "turn": {
      c.usage.requests++; c.usage.prompt += e.prompt ?? 0; c.usage.cached += e.cached ?? 0; c.usage.completion += e.completion ?? 0; c.usage.reasoning += e.reasoning ?? 0; c.usage.perRequest.push({ prompt: e.prompt ?? 0, cached: e.cached ?? 0, completion: e.completion ?? 0 });
      c.step = e.step; const s = c.steps.get(e.step) ?? add(c, { t: "step", step: e.step, max: c.max }); c.steps.set(e.step, s);
      s.usage = { prompt: e.prompt ?? 0, cached: e.cached ?? 0, completion: e.completion ?? 0, reasoning: e.reasoning ?? 0 }; touch(c, s); break;
    }
    case "assistant": if (!e.streamed && !c.modelText && String(e.text ?? "").trim()) add(c, { t: "text", text: clip(e.text) }); break;
    case "toolstart": { const it = c.tools.get(e.id) ?? add(c, { t: "tool", id: e.id, name: e.name, args: args(e.args), result: null, error: false }); c.tools.set(e.id, it); it.status = "running"; touch(c, it); break; }
    case "tool": {
      const it = c.tools.get(e.id) ?? add(c, { t: "tool", id: e.id, name: e.name, args: args(e.args) }); c.tools.set(e.id, it);
      const out = String(e.result ?? e.output ?? ""); it.result = clip(out); it.error = /^(ERROR|DENIED|REJECTED|BLOCKED)/.test(out) || /^exit=(?!0\b)\d+/.test(out); it.status = "done"; touch(c, it); break;
    }
    case "edit": add(c, { t: "edit", path: e.path, created: !!e.created, added: e.added ?? 0, removed: e.removed ?? 0, diff: clip(e.diff ?? "") }); break;
    case "audit": add(c, { t: "audit", changed: e.changed ?? [], notes: e.notes ?? [] }); break;
    case "finish":
      for (const it of c.tools.values()) if (it.name === "finish" && it.status !== "done") { it.status = "done"; it.result = "accepted"; touch(c, it); }   // the harness answers finish itself
      add(c, { t: "finish", text: clip(e.summary ?? "") }); break;
    case "steer": add(c, { t: "steer", text: clip(e.text ?? "") }); break;
    case "policy": add(c, { t: "guard", name: "policy", text: `${e.tool}: ${e.action}${e.reason ? ` (${e.reason})` : ""}` }); break;
    case "result":
      for (const it of c.tools.values()) if (it.status !== "done") { it.status = "skipped"; touch(c, it); }   // planned but never run: the run ended first
      c.result = e; add(c, { t: "end", finished: !!e.finished, stopped: e.stopped ?? null, text: clip(e.text ?? ""), usage: e.usage ?? null, cost: e.cost ?? null }); break;
    default: if (GUARDS.has(e.kind)) add(c, { t: "guard", name: e.kind, text: clip(e.detail ?? "", 2000) });
  }
}

/** The conversation so far: read only what was added to the log since the last look. */
function conversation(job, file) {
  let c = cache.get(job) ?? fresh(), size = 0;
  try { size = statSync(file).size; } catch { return c; }
  if (size < c.size) c = fresh();
  if (size > c.size) {
    const fd = openSync(file, "r"), buf = Buffer.alloc(size - c.size); readSync(fd, buf, 0, buf.length, c.size); closeSync(fd);
    const lines = (c.rest + buf.toString("utf8")).split("\n"); c.rest = lines.pop() ?? "";
    for (const l of lines) { let e; try { e = JSON.parse(l); } catch { continue; } if (e && typeof e === "object") fold(c, e); }
    c.size = size;
  }
  cache.delete(job); cache.set(job, c);
  while (cache.size > 24) cache.delete(cache.keys().next().value);   // keep the most recently viewed jobs
  return c;
}

const tail = (f, n = 4000) => { try { const t = readFileSync(f, "utf8"); return t.length > n ? "…" + t.slice(-n) : t; } catch { return ""; } };
const span = (x) => (x?.started_at ? { start: x.started_at, end: x.finished_at ?? null } : null);

/** Everything the UI shows about one job. Chat items newer than `since` (a seq; -1 for none, 0 for all). */
export function jobView(job, since = 0) {
  const t = trialDir(job); if (!t) return { job, phase: "starting", items: [], seq: 0, usage: null };
  const agentLog = join(t, "agent", "amness.jsonl"), result = join(t, "result.json"), verifier = join(t, "verifier");
  const c = existsSync(agentLog) ? conversation(job, agentLog) : null;
  let res = null; try { res = existsSync(result) ? JSON.parse(readFileSync(result, "utf8")) : null; } catch { /* written in pieces */ }
  const tests = existsSync(join(verifier, "test-stdout.txt")) ? tail(join(verifier, "test-stdout.txt"), 12_000) : "";
  const phase = res?.finished_at ? "done" : tests || existsSync(join(verifier, "reward.txt")) || res?.verifier ? "testing" : c || res?.agent_execution ? "agent" : res?.agent_setup ? "installing" : "setting up";
  return {
    job, phase, task: res?.task_name, items: since < 0 || !c ? [] : c.items.filter((x) => x.seq > since), seq: c?.seq ?? 0, count: c?.items.length ?? 0,
    usage: c?.usage ?? null, step: c?.step ?? null, maxSteps: c?.max ?? null, agentPhase: c?.agentPhase ?? null, final: c?.result ?? null,
    timing: res ? { environment: span(res.environment_setup), install: span(res.agent_setup), agent: span(res.agent_execution), tests: span(res.verifier) } : null,
    tests, reward: res?.verifier_result?.rewards?.reward ?? null, exception: res?.exception_info ? { type: res.exception_info.exception_type, message: String(res.exception_info.exception_message ?? "").slice(0, 2000) } : null,
    stderr: tail(join(t, "agent", "amness.stderr"), 4000), started: res?.started_at ?? null, finished: res?.finished_at ?? null,
  };
}
