// The studio's server: the UI (ui/dist, built with `npm run build`), a JSON API, a live stream (Server-Sent Events) that pushes the campaign,
// the runner's state and the running agent's conversation as it grows, and the controls (start, pause, stop now, resume, run again, warm up).
// The controls need the token (STUDIO_TOKEN) when one is set; without one, anyone who can reach the port can use them. Requests straight from a trusted
// network (STUDIO_TRUST, such as 192.168.1.0/24) need no token; a request through a proxy never counts as trusted, since the proxy may be serving the internet.
// What the runner was doing is kept in <data>/studio.json, so after a restart (a reboot, an update) it carries on, or stays paused.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { currentRun, runKey, listCampaigns, loadCampaign, paths, pending, removeResult, results } from "./campaign.mjs";
import { forget, jobView, mirror } from "./live.mjs";
import { median, summarize } from "./stats.mjs";
import { Runner } from "./runner.mjs";
import { warm, warmth } from "./cache.mjs";
import { campaignFindings, findings } from "./findings.mjs";
import { addBuild, getBuild, listBuilds, resolveBuild } from "./builds.mjs";
import { agentOptions } from "./setup.mjs";
import { hostname } from "node:os";

const UI = resolve(new URL("../ui/dist", import.meta.url).pathname);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };

/** The versions of the agent published on npm (cached for ten minutes), newest first, with the dist-tags. */
let npmCache = null;
function npmVersions(pkg = "amness") {
  if (npmCache && Date.now() - npmCache.at < 10 * 60_000) return Promise.resolve(npmCache.value);
  return new Promise((ok) => execFile("npm", ["view", pkg, "versions", "dist-tags", "time", "--json"], { timeout: 30_000, maxBuffer: 16 << 20 }, (err, out) => {
    if (err) return ok({ versions: [], tags: {}, error: "npm could not be reached" });
    try { const j = JSON.parse(out), vs = [...(j.versions ?? [])].reverse(); const value = { versions: vs.map((v) => ({ version: v, published: j.time?.[v] ?? null })), tags: j["dist-tags"] ?? {} }; npmCache = { at: Date.now(), value }; ok(value); }
    catch { ok({ versions: [], tags: {}, error: "unexpected answer from npm" }); }
  }));
}

/** Check a campaign written in the browser, and turn it into the campaign file's shape. */
export function campaignFile(a) {
  const name = String(a.name ?? "").trim();
  if (!/^[\w.-]{1,60}$/.test(name)) throw new Error("name: letters, digits, dots, dashes and underscores only");
  if (!a.subset || !existsSync(join(paths.subsets, `${a.subset}.txt`))) throw new Error(`no task list "${a.subset}" in subsets/`);
  if (!a.model || !/\//.test(a.model)) throw new Error("model: provider/model, such as custom/qwen-vllm");
  const kv = (o) => Object.entries(o ?? {}).filter(([, v]) => v !== "" && v !== null && v !== undefined).flatMap(([k, v]) => { if (!/^[a-z_]+$/.test(k)) throw new Error(`option ${k}: lower-case letters and _`); return ["--ak", `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`]; });
  const variants = {};
  for (const v of a.variants ?? []) {
    const vn = String(v.name ?? "").trim(); if (!/^[\w.-]{1,40}$/.test(vn)) throw new Error(`variant name "${vn}": letters, digits, dots, dashes, underscores`);
    if (variants[vn]) throw new Error(`two variants are called ${vn}`);
    variants[vn] = { args: kv(v.options), ...(v.build ? { build: v.build } : {}), ...(v.note ? { note: v.note } : {}) };
  }
  if (!Object.keys(variants).length) throw new Error("add at least one variant");
  const trials = Math.max(1, Math.min(20, Number(a.trials) || 1));
  return { name, plan: { purpose: String(a.purpose ?? ""), about: String(a.about ?? ""), subset: a.subset, model: a.model, ...(a.dataset ? { dataset: a.dataset } : {}), ...(a.build ? { build: a.build } : {}), args: kv(a.options), trials, variants, createdAt: new Date().toISOString(), ...(a.from ? { from: a.from } : {}) } };
}

/** IPv4 ranges (a.b.c.d/n, comma separated) and whether an address is in one. IPv4 inside IPv6 (::ffff:a.b.c.d) counts as IPv4. */
export function parseTrust(spec = "") {
  return String(spec).split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const [ip, bits = "32"] = s.split("/"), n = ipv4(ip), b = Number(bits);
    if (n === null || !(b >= 0 && b <= 32)) throw new Error(`STUDIO_TRUST: not an IPv4 range: ${s}`);
    const mask = b === 0 ? 0 : (~0 << (32 - b)) >>> 0; return { net: (n & mask) >>> 0, mask };
  });
}
function ipv4(a) { const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(String(a ?? "")); if (!m) return null; const p = m.slice(1).map(Number); return p.some((x) => x > 255) ? null : ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0; }
export const trusted = (ranges, addr) => { const n = ipv4(addr); return n !== null && ranges.some((r) => ((n & r.mask) >>> 0) === r.net); };
const viaProxy = (req) => !!(req.headers["x-forwarded-for"] || req.headers.forwarded || req.headers["x-real-ip"]);

const buildSummary = (b) => (b ? { id: b.id, version: b.version, commit: b.commit, note: b.note, addedAt: b.addedAt, source: b.source, features: b.features ?? [] } : null);

/** How the campaign runs: its purpose, the build, the options every variant shares, what each variant changes from the first, and where it runs. */
export function campaignSetup(c, rs, cur) {
  const shared = agentOptions(c.plan.args ?? []), base = c.variant(c.variants[0]), baseOpts = agentOptions(base.args).opts;
  const variants = c.variants.map((v, i) => {
    const x = c.variant(v), o = agentOptions(x.args).opts, b = resolveBuild(x.build);
    const changes = i === 0 ? [] : [...new Set([...Object.keys(o), ...Object.keys(baseOpts)])].filter((k) => o[k] !== baseOpts[k]).map((k) => ({ option: k, from: baseOpts[k] ?? null, to: o[k] ?? null }));
    if (i > 0 && x.build !== base.build) changes.push({ option: "build", from: base.build, to: x.build });
    return { name: v, note: x.note, options: o, other: agentOptions(x.args).other, build: buildSummary(b) ?? (x.build ? { id: x.build, missing: true } : null), changes };
  });
  const last = cur?.setup ?? [...rs].reverse().find((r) => r.setup)?.setup ?? null;
  return {
    purpose: c.plan.purpose ?? "", about: c.plan.about ?? "", agent: c.plan.agent ?? "amness_agent:Amness", model: c.plan.model, dataset: c.plan.dataset ?? "terminal-bench@2.0", subset: c.plan.subset, trials: c.plan.trials ?? 1,
    build: buildSummary(resolveBuild(c.plan.build)) ?? (c.plan.build ? { id: c.plan.build, missing: true } : shared.opts.package ? { package: shared.opts.package } : null),
    shared: shared.opts, sharedOther: shared.other, variants,
    where: { studio: hostname(), host: last?.where?.host ?? null, harbor: last?.where?.harbor ?? null, cpus: last?.where?.cpus ?? null, memoryGb: last?.where?.memoryGb ?? null, endpoint: shared.opts.endpoint ?? null, server: last?.server ?? null },
    recorded: rs.filter((r) => r.setup).length,
  };
}

/** The whole picture of one campaign, small enough to push often. */
export function overview(name) {
  const c = loadCampaign(name), rs = results(c), left = pending(c), cur = currentRun(c), per = median(rs.map((r) => r.seconds)) ?? 18 * 60;
  return {
    name, purpose: c.plan.purpose ?? "", about: c.plan.about ?? "", model: c.plan.model, setup: campaignSetup(c, rs, cur), dataset: c.plan.dataset ?? "terminal-bench@2.0", tasks: c.tasks, variants: c.variants, total: c.runs.length, trials: c.plan.trials ?? 1,
    done: rs.length, left: left.length, etaSeconds: left.length * per, perRunSeconds: per, next: left[0] ?? null, upcoming: left.filter((r) => !cur || runKey(r) !== runKey(cur)).slice(0, 6),
    summary: summarize(rs, c.variants), checks: campaignFindings(rs), results: rs.map(({ setup, ...r }) => ({ ...r, build: setup?.build?.version ?? null })),   // the full setup comes with the run (/api/job) current: cur ? { ...jobView(cur.job, -1), ...cur } : null,   // the plan's task and variant win over what the job folder knows so far
  };
}

export function serve({ port = 8090, host = "0.0.0.0", token = process.env.STUDIO_TOKEN || "", trust = process.env.STUDIO_TRUST || "", runner = new Runner(), resume = true } = {}) {
  const trustRanges = parseTrust(trust);
  const stateFile = join(paths.data, "studio.json");
  let quitting = false;
  const save = () => { if (quitting) return; try { mkdirSync(paths.data, { recursive: true }); writeFileSync(stateFile, JSON.stringify({ campaign: runner.campaign, want: ["running", "pausing"].includes(runner.status) ? (runner.status === "running" ? "running" : "paused") : runner.status })); } catch { /* read-only data folder */ } };
  runner.on("change", (s) => { if (s.status !== "pausing") save(); });
  runner.on("result", (r) => setTimeout(() => forget(r.job), 5000));         // Harbor has the real logs now
  if (resume) try {
    const s = JSON.parse(readFileSync(stateFile, "utf8"));
    if (s.campaign) { runner.campaign = s.campaign; runner.status = s.want === "running" ? "idle" : s.want === "done" ? "done" : "paused"; }
    if (s.want === "running" && s.campaign) { runner.start(s.campaign); warm(loadCampaign(s.campaign), runner.say); }
  } catch { /* first start */ }

  const send = (res, code, body, type = "application/json") => { res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  const fromTrusted = (req) => trustRanges.length > 0 && !viaProxy(req) && trusted(trustRanges, req.socket.remoteAddress);
  const allowed = (req) => {
    if (!token || fromTrusted(req)) return true;
    const got = Buffer.from(String(req.headers["x-studio-token"] ?? "")), want = Buffer.from(token);
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const building = { busy: false, spec: null, log: [], error: null, last: null };
  const state = () => ({ ...runner.state(), warm: warmth, building, auth: !!token });
  const body = (req) => new Promise((ok, no) => { let b = ""; req.on("data", (d) => { b += d; if (b.length > 1e5) no(new Error("too large")); }); req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } }); });

  async function control(a) {
    const name = a.campaign ?? runner.campaign;
    switch (a.action) {
      case "start": case "resume": runner.start(name, { minutes: Number(a.minutes) || 0 }); warm(loadCampaign(name), runner.say); break;
      case "pause": runner.pause(); break;
      case "stop": runner.stopNow(); break;
      case "campaign-create": {
        const { name: n, plan } = campaignFile(a.campaign ?? {}), f = join(paths.campaigns, `${n}.json`);
        if (existsSync(f)) throw new Error(`a campaign called ${n} exists already: choose another name`);
        for (const v of Object.values(plan.variants)) if (v.build && !resolveBuild(v.build)) throw new Error(`build ${v.build} is not in the studio: add it first`);
        if (plan.build && !resolveBuild(plan.build)) throw new Error(`build ${plan.build} is not in the studio: add it first`);
        mkdirSync(paths.campaigns, { recursive: true }); writeFileSync(f, JSON.stringify(plan, null, 2) + "\n"); runner.say(`campaign ${n} created${plan.from ? ` from ${plan.from}` : ""}`);
        if (a.start) { runner.start(n, { minutes: Number(a.minutes) || 0 }); warm(loadCampaign(n), runner.say); }
        return { ...state(), created: n };
      }
      case "rerun": if (!removeResult(loadCampaign(name), String(a.key ?? ""))) throw new Error("no such result"); runner.say(`result removed, it runs again: ${a.key}`); break;
      case "warm": warm(loadCampaign(name), runner.say); break;
      case "build-add": {
        if (!a.spec) throw new Error("say which build: a version, git:<ref>, or a path to a .tgz");
        if (building.busy) throw new Error("a build is being added already");
        Object.assign(building, { busy: true, spec: a.spec, log: [], error: null });
        addBuild(String(a.spec), { note: String(a.note ?? ""), say: (m) => { building.log.push(m); runner.say(`build: ${m}`); } })
          .then((m) => { building.last = m.id; }).catch((e) => { building.error = e.message; runner.say(`build failed: ${e.message}`); }).finally(() => { building.busy = false; runner.emit("change", runner.state()); });
        break;
      }
      default: throw new Error(`unknown action: ${a.action}`);
    }
    return state();
  }

  const server = createServer(async (req, res) => {
    const u = new URL(req.url, "http://x"), p = u.pathname;
    try {
      if (p === "/api/control") {
        if (req.method !== "POST") return send(res, 405, { error: "POST only" });
        if (!/^application\/json/.test(req.headers["content-type"] ?? "")) return send(res, 415, { error: "JSON only" });   // no plain form posts from other sites
        if (!allowed(req)) return send(res, 401, { error: "the studio token is needed for this" });
        try { return send(res, 200, await control(await body(req))); } catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (req.method !== "GET") return send(res, 405, { error: "GET only" });
      if (p === "/api/state") return send(res, 200, { ...state(), trusted: fromTrusted(req) });
      if (p === "/api/campaigns") return send(res, 200, listCampaigns().map((n) => {
        try {
          const c = loadCampaign(n), rs = results(c), cur = currentRun(c), s = campaignSetup(c, rs, cur), passed = rs.filter((r) => r.reward >= 1).length;
          return { name: n, purpose: s.purpose, about: s.about, model: s.model, dataset: s.dataset, build: s.build, variants: c.variants.length, tasks: c.tasks.length, trials: s.trials,
            done: rs.length, total: c.runs.length, passed, running: !!cur, lastAt: cur?.started ?? rs.at(-1)?.at ?? null, where: s.where, active: runner.campaign === n ? runner.status : null };
        } catch (e) { return { name: n, error: e.message }; }
      }));
      if (p === "/api/builds") {
        // Each build with the campaigns that used it: runs and passes per campaign, and over all.
        const use = new Map();
        for (const n of listCampaigns()) { let c; try { c = loadCampaign(n); } catch { continue; } for (const r of results(c)) { const id = r.setup?.build?.id ?? resolveBuild(c.variant(r.variant).build)?.id; if (!id) continue; const u = use.get(id) ?? new Map(); const e = u.get(n) ?? { campaign: n, purpose: c.plan.purpose ?? "", runs: 0, passed: 0, last: null }; e.runs++; if (r.reward >= 1) e.passed++; e.last = r.at; u.set(n, e); use.set(id, u); } }
        return send(res, 200, listBuilds().map((b) => { const u = [...(use.get(b.id)?.values() ?? [])]; return { ...b, usedBy: u, runs: u.reduce((a, x) => a + x.runs, 0), passed: u.reduce((a, x) => a + x.passed, 0) }; }));
      }
      if (p === "/api/npm") return send(res, 200, await npmVersions());
      if (p === "/api/subsets") return send(res, 200, existsSync(paths.subsets) ? readdirSync(paths.subsets).filter((f) => f.endsWith(".txt")).map((f) => { const tasks = readFileSync(join(paths.subsets, f), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")); return { name: f.slice(0, -4), tasks }; }) : []);
      if (p.startsWith("/api/campaign-file/")) { const c = loadCampaign(decodeURIComponent(p.slice(19))); return send(res, 200, { name: c.name, plan: c.plan }); }
      if (p.startsWith("/api/build/")) { const b = getBuild(decodeURIComponent(p.slice(11))); return b ? send(res, 200, b) : send(res, 404, { error: "no such build" }); }
      if (p.startsWith("/api/campaign/")) return send(res, 200, overview(decodeURIComponent(p.slice(14))));
      if (p.startsWith("/api/job/")) {
        const job = decodeURIComponent(p.slice(9)), v = jobView(job, Number(u.searchParams.get("since") ?? 0));
        let setup = null; for (const n of listCampaigns()) { if (!job.startsWith(n + "-")) continue; try { const c = loadCampaign(n), cur = currentRun(c); setup = (cur?.job === job ? cur.setup : results(c).find((r) => r.job === job)?.setup) ?? setup; } catch { /* skip */ } }
        return send(res, 200, { ...v, findings: findings(job), setup });
      }
      if (p === "/api/stream") {
        // Live, once a second: the runner's state; the campaign when it changed; the running job's status and its new conversation items.
        const name = u.searchParams.get("campaign") || runner.campaign || listCampaigns()[0];
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
        let job = null, since = 0, last = "", lastState = "";
        const tick = () => {
          try {
            const msg = {}, o = overview(name), ov = JSON.stringify({ ...o, current: o.current ? { task: o.current.task, variant: o.current.variant, trial: o.current.trial, job: o.current.job, started: o.current.started, setup: o.current.setup ?? null } : null });
            if (ov !== last) { msg.overview = JSON.parse(ov); last = ov; }
            const st = JSON.stringify(state()); if (st !== lastState) { msg.state = JSON.parse(st); lastState = st; }
            if ((o.current?.job ?? null) !== job) { job = o.current?.job ?? null; since = 0; msg.reset = true; }
            if (job) mirror(job);                                                // the agent's log, from inside the container, for the next tick
            if (job) { const v = jobView(job, since); since = v.seq; msg.live = { ...v, findings: findings(job), task: o.current.task, variant: o.current.variant, trial: o.current.trial, startedAt: o.current.started }; }
            res.write(`data: ${JSON.stringify(msg)}\n\n`);
          } catch (e) { res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`); }
        };
        tick(); const t = setInterval(tick, 1000); req.on("close", () => clearInterval(t)); return;
      }
      if (p.startsWith("/api/")) return send(res, 404, { error: "no such endpoint" });
      if (!existsSync(join(UI, "index.html"))) return send(res, 503, "The UI is not built yet: run `npm install && npm run build` in the studio's folder.", "text/plain; charset=utf-8");
      let f = join(UI, p === "/" ? "index.html" : p.replace(/^\/+/, ""));
      if (!f.startsWith(UI + "/") && f !== UI) return send(res, 404, "not found", "text/plain");
      if (!extname(f)) f = join(UI, "index.html");                          // the app's own routes
      else if (!existsSync(f)) return send(res, 404, "not found", "text/plain");
      return send(res, 200, readFileSync(f), TYPES[extname(f)] ?? "application/octet-stream");
    } catch (e) { return send(res, 500, { error: e.message }); }
  }).listen(port, host, () => console.log(`Amness Evaluation Studio: http://${host === "0.0.0.0" ? "<this machine>" : host}:${port}/${token ? ` (controls need the token${trustRanges.length ? ` except from ${trust}` : ""})` : " (controls open to anyone who can reach this port)"}`));
  server.runner = runner;
  /** For a restart (an update, a reboot): interrupt the run in progress (it runs again) but keep the saved state, so the next start carries on. */
  server.shutdown = async () => { quitting = true; runner.stopNow(); await runner.done(); server.close(); server.closeAllConnections?.(); };
  return server;
}
