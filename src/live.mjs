// What a Harbor job is doing right now, read from its folder: the phase (setting up, the agent working, the tests running, done),
// the agent's events so far (from Amness's --json log, read incrementally), and the tests' output when they ran.
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./campaign.mjs";

const cache = new Map();   // job -> { size, events, usage, last }

export function trialDir(job) {
  const jd = join(paths.jobs, job);
  if (!/^[\w.-]+$/.test(job) || !existsSync(jd)) return null;
  const t = readdirSync(jd).find((d) => { try { return statSync(join(jd, d)).isDirectory(); } catch { return false; } });
  return t ? join(jd, t) : null;
}

/** One event of the agent, shortened for display; text deltas and thinking chunks are left out (the final message is kept). */
function brief(e) {
  const s = (x, n = 160) => String(x ?? "").replace(/\s+/g, " ").slice(0, n);
  switch (e.kind) {
    case "toolstart": { let a = e.args; try { a = typeof a === "string" ? JSON.parse(a) : a; } catch { /* keep the text */ } const main = a && typeof a === "object" ? a.cmd ?? a.path ?? a.pattern ?? a.query ?? a.url ?? JSON.stringify(a) : a; return { k: "tool", name: e.name, text: s(main, 200) }; }
    case "tool": return { k: "result", name: e.name, text: s(e.result ?? e.output ?? "", 160), error: /^(ERROR|DENIED|REJECTED|BLOCKED)/.test(String(e.result ?? "")) };
    case "edit": return { k: "edit", text: `${e.path}${e.created ? " (new)" : ""} +${e.added ?? 0} −${e.removed ?? 0}` };
    case "assistant": return { k: "say", text: s(e.text, 400) };
    case "nudge": case "rejected": case "denied": case "loop": case "rollover": case "budget": case "aborted": case "repair": return { k: "guard", name: e.kind, text: s(e.detail, 200) };
    case "policy": return { k: "guard", name: "policy", text: s(`${e.tool}: ${e.action} (${e.reason ?? ""})`, 200) };
    case "steer": return { k: "steer", text: s(e.text, 200) };
    case "result": return { k: "end", text: s(`${e.finished ? "finished" : "stopped"}${e.stopped ? ` (${e.stopped})` : ""}: ${e.text ?? ""}`, 500) };
    default: return null;
  }
}

/** The agent's events so far: read only what was added since the last look. */
function agentEvents(job, file) {
  let c = cache.get(job) ?? { size: 0, events: [], usage: { requests: 0, prompt: 0, cached: 0, completion: 0, perRequest: [] }, rest: "", result: null };
  let size = 0; try { size = statSync(file).size; } catch { return c; }
  if (size < c.size) c = { size: 0, events: [], usage: { requests: 0, prompt: 0, cached: 0, completion: 0, perRequest: [] }, rest: "", result: null };
  if (size > c.size) {
    const fd = openSync(file, "r"), buf = Buffer.alloc(size - c.size); readSync(fd, buf, 0, buf.length, c.size); closeSync(fd);
    const lines = (c.rest + buf.toString("utf8")).split("\n"); c.rest = lines.pop() ?? "";
    for (const l of lines) {
      let e; try { e = JSON.parse(l); } catch { continue; }
      if (e.kind === "turn") { c.usage.requests++; c.usage.prompt += e.prompt ?? 0; c.usage.cached += e.cached ?? 0; c.usage.completion += e.completion ?? 0; c.usage.perRequest.push(e.prompt ?? 0); c.step = e.step; continue; }
      if (e.kind === "result") c.result = e;
      const b = brief(e); if (b) { c.events.push({ ...b, i: c.events.length }); if (c.events.length > 600) c.events.splice(0, c.events.length - 600); }
    }
    c.size = size;
  }
  cache.set(job, c); return c;
}

const tail = (f, n = 4000) => { try { const t = readFileSync(f, "utf8"); return t.length > n ? "…" + t.slice(-n) : t; } catch { return ""; } };

/** Everything the UI shows about one job. `since` returns only events newer than that index. */
export function jobView(job, since = -1) {
  const t = trialDir(job); if (!t) return { job, phase: "starting", events: [], usage: null };
  const agentLog = join(t, "agent", "amness.jsonl"), result = join(t, "result.json"), verifier = join(t, "verifier");
  const a = existsSync(agentLog) ? agentEvents(job, agentLog) : null;
  let res = null; try { res = existsSync(result) ? JSON.parse(readFileSync(result, "utf8")) : null; } catch { /* written in pieces */ }
  const tests = existsSync(join(verifier, "test-stdout.txt")) ? tail(join(verifier, "test-stdout.txt")) : "";
  const phase = res?.finished_at ? "done" : tests || existsSync(join(verifier, "reward.txt")) ? "testing" : a ? "agent" : "setting up";
  return {
    job, phase, task: res?.task_name, events: (a?.events ?? []).filter((e) => e.i > since), lastIndex: (a?.events.length ?? 0) - 1, usage: a?.usage ?? null, step: a?.step ?? null, final: a?.result ?? null,
    tests, reward: res?.verifier_result?.rewards?.reward ?? null, exception: res?.exception_info ? { type: res.exception_info.exception_type, message: String(res.exception_info.exception_message ?? "").slice(0, 600) } : null,
    stderr: tail(join(t, "agent", "amness.stderr"), 2000), started: res?.started_at ?? null, finished: res?.finished_at ?? null,
  };
}
