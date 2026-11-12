// What a Harbor job is doing right now, read from its folder: the phase (setting up, the agent working, the tests running, done), timings,
// the agent's conversation so far (from Amness's --json log, read incrementally), and the tests' output when they ran.
//
// The conversation is a list of items (system prompt, task, step, thinking, text, tool call, edit, guard action, audit, finish, end). Items change
// while they stream (thinking grows, a tool call gets its result), so each carries `seq`, the change counter when it last changed: a client that
// has seen up to seq N asks for the items with seq > N and replaces them by index.
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { basename, join } from "node:path";
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

// Harbor copies the agent's logs out of the container only when the run ends. While it runs, `mirror` copies the new part of the log
// out of the container (docker exec) into <data>/.live/<job>/, and the view reads that copy.
const mirrors = new Map();   // job -> { busy, size, container }
const docker = (args) => new Promise((ok) => execFile("docker", args, { maxBuffer: 64 << 20, timeout: 20_000, encoding: "buffer" }, (err, out) => ok(err ? null : out)));
const liveDir = (job) => join(paths.data, ".live", job);

/** Copy what the running agent has written since the last call. Cheap to call every second; one copy at a time per job. */
export async function mirror(job) {
  const t = trialDir(job); if (!t || existsSync(join(t, "result.json")) && existsSync(join(t, "agent", "amness.jsonl"))) return;
  const m = mirrors.get(job) ?? { busy: false, size: {}, container: null }; mirrors.set(job, m);
  if (m.busy) return; m.busy = true;
  try {
    if (!m.container) {
      const project = basename(t).toLowerCase() + "__env";
      m.container = String((await docker(["ps", "-q", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.service=main"])) ?? "").trim().split("\n")[0] || null;
      if (!m.container) return;
    }
    mkdirSync(liveDir(job), { recursive: true });
    for (const [file, from] of [["amness.jsonl", "/logs/agent/amness.jsonl"], ["amness.stderr", "/logs/agent/amness.stderr"], ["test-stdout.txt", "/logs/verifier/test-stdout.txt"]]) {
      const have = m.size[file] ?? 0, out = await docker(["exec", m.container, "sh", "-c", `[ -f ${from} ] && tail -c +${have + 1} ${from} || true`]);
      if (out === null) { m.container = null; break; }   // the container is gone: the run is ending
      if (out.length) { appendFileSync(join(liveDir(job), file), out); m.size[file] = have + out.length; }
    }
  } finally { m.busy = false; }
}

/** Drop the copies of finished runs (Harbor has the real logs by then). */
export function forget(job) { mirrors.delete(job); rmSync(liveDir(job), { recursive: true, force: true }); }

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
    case "ladder": add(c, { t: "guard", name: "ladder", text: clip(`${e.action}: ${e.from} → ${e.to} (${e.reason}; risk ${e.risk})`, 2000) }); break;
    case "takeover": add(c, { t: "guard", name: "takeover", text: clip(`${e.role} on ${e.model} handed back (${e.reason}; ${e.count} so far)`, 2000) }); break;
    case "repair": add(c, { t: "guard", name: e.fixed ? "argfix" : "repair", text: clip(e.detail ?? "", 2000) }); break;
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

// Agents other than Amness (Harbor's terminus-2 and others) write a trajectory in Harbor's ATIF format (agent/trajectory.json), rewritten
// in place as the run goes, on the host. It is read whole when it changed and turned into the same items; an item keeps its seq while it is
// unchanged, so a client still gets only what is new or changed.
const trajCache = new Map();   // job -> { size, mtime, seq, keys: string[], items, usage, step }
function stepItems(st) {
  const out = [], calls = st.tool_calls ?? [], results = st.observation?.results ?? [];
  const text = typeof st.message === "string" ? st.message : content({ content: st.message });
  if (st.source !== "agent") { if (text.trim()) out.push({ t: st.step_id === 1 ? "system" : "user", text: clip(text) }); return out; }
  out.push({ t: "step", step: st.step_id, max: null, usage: st.metrics ? { prompt: st.metrics.prompt_tokens ?? 0, cached: st.metrics.cached_tokens ?? 0, completion: st.metrics.completion_tokens ?? 0, reasoning: 0 } : null });
  const think = String(st.reasoning_content ?? "").replace(/^<think>\s*|\s*<\/think>$/g, "");
  if (think.trim()) out.push({ t: "thinking", text: clip(think), live: false });
  if (text.trim()) out.push({ t: "text", text: clip(text) });
  calls.forEach((tc, k) => {
    const own = results.filter((r) => r.source_call_id === tc.tool_call_id), loose = results.filter((r) => !r.source_call_id);
    const res = own.length ? own : k === calls.length - 1 ? loose : [];   // a terminal agent's screen belongs to the whole batch: shown once, under its last command
    const out1 = res.map((r) => (typeof r.content === "string" ? r.content : content({ content: r.content }))).join("\n");
    out.push({ t: "tool", id: tc.tool_call_id, name: tc.function_name, args: tc.arguments ?? {}, status: res.length || !st.observation ? (res.length ? "done" : "running") : "done", result: res.length ? clip(out1) : null, error: false });
  });
  if (!calls.length && results.length) out.push({ t: "text", text: clip(results.map((r) => r.content).join("\n")) });
  return out;
}
function trajectory(job, file) {
  let st; try { st = statSync(file); } catch { return null; }
  const c = trajCache.get(job) ?? { size: -1, mtime: 0, seq: 0, keys: [], items: [], usage: null, step: null, final: null };
  if (st.size === c.size && st.mtimeMs === c.mtime) return c;
  let t; try { t = JSON.parse(readFileSync(file, "utf8")); } catch { return c; }   // caught mid-write: keep the last good read
  const items = (t.steps ?? []).flatMap(stepItems), keys = items.map((x) => JSON.stringify(x));
  const usage = { requests: 0, prompt: 0, cached: 0, completion: 0, reasoning: 0, perRequest: [] };
  for (const x of t.steps ?? []) if (x.metrics) { usage.requests++; usage.prompt += x.metrics.prompt_tokens ?? 0; usage.cached += x.metrics.cached_tokens ?? 0; usage.completion += x.metrics.completion_tokens ?? 0; usage.perRequest.push({ prompt: x.metrics.prompt_tokens ?? 0, cached: x.metrics.cached_tokens ?? 0, completion: x.metrics.completion_tokens ?? 0 }); }
  items.forEach((x, i) => { x.i = i; x.seq = keys[i] === c.keys[i] ? c.items[i].seq : ++c.seq; });
  if (items.length < c.items.length) c.seq++;   // shorter than before (a new attempt): the client starts over below
  Object.assign(c, { size: st.size, mtime: st.mtimeMs, keys, items, usage, step: (t.steps ?? []).filter((x) => x.source === "agent").length || null, final: t.final_metrics ?? null, agent: t.agent ?? null });
  trajCache.delete(job); trajCache.set(job, c); while (trajCache.size > 24) trajCache.delete(trajCache.keys().next().value);
  return c;
}

const tail = (f, n = 4000) => { try { const t = readFileSync(f, "utf8"); return t.length > n ? "…" + t.slice(-n) : t; } catch { return ""; } };
const span = (x) => (x?.started_at ? { start: x.started_at, end: x.finished_at ?? null } : null);

/** Everything the UI shows about one job. Chat items newer than `since` (a seq; -1 for none, 0 for all). */
export function jobView(job, since = 0) {
  const t = trialDir(job); if (!t) return { job, phase: "starting", items: [], seq: 0, usage: null };
  const result = join(t, "result.json"), verifier = join(t, "verifier"), copy = liveDir(job);
  const pick = (real, name) => (existsSync(real) ? real : existsSync(join(copy, name)) ? join(copy, name) : null);   // Harbor's copy once the run ended, else ours
  const agentLog = pick(join(t, "agent", "amness.jsonl"), "amness.jsonl"), testsOut = pick(join(verifier, "test-stdout.txt"), "test-stdout.txt");
  const traj = agentLog ? null : existsSync(join(t, "agent", "trajectory.json")) ? join(t, "agent", "trajectory.json") : null;
  const c = agentLog ? conversation(job, agentLog) : traj ? trajectory(job, traj) : null;
  let res = null; try { res = existsSync(result) ? JSON.parse(readFileSync(result, "utf8")) : null; } catch { /* written in pieces */ }
  const tests = testsOut ? tail(testsOut, 12_000) : "";
  const phase = res?.finished_at ? "done" : tests || existsSync(join(verifier, "reward.txt")) || res?.verifier || c?.result ? "testing" : c || res?.agent_execution ? "agent" : res?.agent_setup ? "installing" : "setting up";
  return {
    job, phase, task: res?.task_name, items: since < 0 || !c ? [] : c.items.filter((x) => x.seq > since), seq: c?.seq ?? 0, count: c?.items.length ?? 0,
    usage: c?.usage ?? null, step: c?.step ?? null, maxSteps: c?.max ?? null, agentPhase: c?.agentPhase ?? (traj && !res?.finished_at ? "model" : null), final: c?.result ?? null, agent: traj ? c?.agent?.name ?? "other" : "amness",
    timing: res ? { environment: span(res.environment_setup), install: span(res.agent_setup), agent: span(res.agent_execution), tests: span(res.verifier) } : null,
    tests, reward: res?.verifier_result?.rewards?.reward ?? null, exception: res?.exception_info ? { type: res.exception_info.exception_type, message: String(res.exception_info.exception_message ?? "").slice(0, 2000) } : null,
    stderr: tail(pick(join(t, "agent", "amness.stderr"), "amness.stderr") ?? "", 4000), started: res?.started_at ?? null, finished: res?.finished_at ?? null,
  };
}
