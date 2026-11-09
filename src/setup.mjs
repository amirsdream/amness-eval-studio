// What a run was, recorded with its result: which build (version, commit), the exact Harbor command, where it ran (this machine, Harbor's version),
// the model server as it was configured at that moment, and the task's image. After the run, the agent's own report of its effective settings
// (Amness 0.7.3+: the first `config` event of `amness run --json`) is added. Together they answer: what was tested, with which version, how, and where.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, openSync, readSync, closeSync } from "node:fs";
import { cpus, hostname, totalmem } from "node:os";
import { join } from "node:path";
import { buildPackage, resolveBuild } from "./builds.mjs";
import { cachedTasks, imageOf } from "./cache.mjs";
import { trialDir } from "./live.mjs";

const out = (cmd, args, timeout = 15_000) => new Promise((ok) => execFile(cmd, args, { timeout }, (err, stdout) => ok(err ? null : String(stdout).trim())));
let harbor = null;
const server = new Map();   // endpoint -> { at, value }

/** `--ak name=value` pairs of Harbor arguments as an object (the agent's options); other arguments are kept as a list. */
export function agentOptions(args = []) {
  const opts = {}, other = [];
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--ak" || args[i] === "--agent-kwarg") && args[i + 1]) { const s = String(args[++i]), k = s.indexOf("="); opts[s.slice(0, k)] = s.slice(k + 1); }
    else other.push(args[i]);
  }
  return { opts, other };
}

/** The model server's own settings: llama.cpp's /props (model file, context, slots, sampling defaults, its build), or the model list of any OpenAI-compatible server. */
export async function serverInfo(endpoint) {
  if (!endpoint) return null;
  const hit = server.get(endpoint); if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
  const base = endpoint.replace(/\/v1\/?$/, ""), get = async (u) => { try { const r = await fetch(u, { signal: AbortSignal.timeout(5000) }); return r.ok ? await r.json() : null; } catch { return null; } };
  let value = { endpoint };
  const p = await get(`${base}/props`);
  if (p) {
    const g = p.default_generation_settings ?? {}, s = g.params ?? g;
    value = { ...value, kind: "llama.cpp", model: p.model_path?.split("/").pop() ?? null, build: p.build_info ?? null, slots: p.total_slots ?? null, context: g.n_ctx ?? null,
      sampling: Object.fromEntries(["temperature", "top_k", "top_p", "min_p", "presence_penalty", "repeat_penalty"].filter((k) => s[k] !== undefined).map((k) => [k, Math.round(s[k] * 1000) / 1000])) };
  } else { const m = await get(`${endpoint.replace(/\/$/, "")}/models`); if (m?.data) value = { ...value, kind: "openai-compatible", models: m.data.map((x) => x.id).slice(0, 10) }; }
  server.set(endpoint, { at: Date.now(), value }); return value;
}

/** Everything to record before a run starts. `harborArgs` is the full command; `variant` is the campaign's resolved variant. */
export async function runSetup(c, r, harborArgs) {
  const v = c.variant(r.variant), b = resolveBuild(v.build), { opts } = agentOptions(harborArgs);   // from the command really run (a build's package included)
  harbor ??= (await out(process.env.HARBOR ?? "harbor", ["--version"])) ?? "unknown";
  const toml = cachedTasks().get(r.task), image = toml ? imageOf(toml) : null;
  const digest = image ? await out("docker", ["image", "inspect", "--format", "{{index .RepoDigests 0}}", image], 10_000) : null;
  return {
    purpose: c.plan.purpose ?? null, campaignSha: createHash("sha256").update(JSON.stringify(c.plan)).digest("hex").slice(0, 12),
    build: b ? { id: b.id, version: b.version, commit: b.commit, note: b.note } : v.build ? { id: v.build, missing: true } : opts.package ? { package: opts.package } : null,
    agent: c.plan.agent ?? "amness_agent:Amness", model: c.plan.model, options: opts, command: ["harbor", ...harborArgs],
    where: { host: hostname(), cpus: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30), harbor },
    server: await serverInfo(opts.endpoint), image: image ? { name: image, digest } : null,
  };
}

/** The Harbor arguments that point the adapter at a build's package (replacing a `package=` the campaign may also have). */
export function buildArgs(c, r) {
  const v = c.variant(r.variant), b = resolveBuild(v.build);
  if (!v.build) return { args: [...(c.plan.args ?? []), ...v.args] };
  if (!b) throw new Error(`build ${v.build} is not in the studio: add it with \`studio build add\``);
  const drop = (a) => { const o = []; for (let i = 0; i < a.length; i++) { if ((a[i] === "--ak" || a[i] === "--agent-kwarg") && /^package=/.test(a[i + 1] ?? "")) { i++; continue; } o.push(a[i]); } return o; };
  return { args: [...drop(c.plan.args ?? []), ...drop(v.args), "--ak", `package=${buildPackage(b.id)}`] };
}

/** The agent's report of its effective settings (the first `config` event of its log), when its version sends one. */
export function effectiveSettings(job) {
  const t = trialDir(job), f = t && join(t, "agent", "amness.jsonl"); if (!f || !existsSync(f)) return null;
  const fd = openSync(f, "r"), buf = Buffer.alloc(64 * 1024), n = readSync(fd, buf, 0, buf.length, 0); closeSync(fd);
  for (const line of buf.subarray(0, n).toString("utf8").split("\n").slice(0, 40)) { try { const e = JSON.parse(line); if (e.kind === "config") { const { kind, ...rest } = e; return rest; } } catch { /* partial line */ } }
  return null;
}
