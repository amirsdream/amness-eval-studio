// The studio's server: the UI (ui/dist, built with `npm run build`), a JSON API, a live stream (Server-Sent Events) that pushes the campaign,
// the runner's state and the running agent's conversation as it grows, and the controls (start, pause, stop now, resume, run again, warm up).
// The controls need the token (STUDIO_TOKEN) when one is set; without one, anyone who can reach the port can use them.
// What the runner was doing is kept in <data>/studio.json, so after a restart (a reboot, an update) it carries on, or stays paused.
import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { currentRun, runKey, listCampaigns, loadCampaign, paths, pending, removeResult, results } from "./campaign.mjs";
import { forget, jobView, mirror } from "./live.mjs";
import { median, summarize } from "./stats.mjs";
import { Runner } from "./runner.mjs";
import { warm, warmth } from "./cache.mjs";

const UI = resolve(new URL("../ui/dist", import.meta.url).pathname);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };

/** The whole picture of one campaign, small enough to push often. */
export function overview(name) {
  const c = loadCampaign(name), rs = results(c), left = pending(c), cur = currentRun(c), per = median(rs.map((r) => r.seconds)) ?? 18 * 60;
  return {
    name, about: c.plan.about ?? "", model: c.plan.model, dataset: c.plan.dataset ?? "terminal-bench@2.0", tasks: c.tasks, variants: c.variants, total: c.runs.length, trials: c.plan.trials ?? 1,
    done: rs.length, left: left.length, etaSeconds: left.length * per, perRunSeconds: per, next: left[0] ?? null, upcoming: left.filter((r) => !cur || runKey(r) !== runKey(cur)).slice(0, 6),
    summary: summarize(rs, c.variants), results: rs, current: cur ? { ...jobView(cur.job, -1), ...cur } : null,   // the plan's task and variant win over what the job folder knows so far
  };
}

export function serve({ port = 8090, host = "0.0.0.0", token = process.env.STUDIO_TOKEN || "", runner = new Runner(), resume = true } = {}) {
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
  const allowed = (req) => {
    if (!token) return true;
    const got = Buffer.from(String(req.headers["x-studio-token"] ?? "")), want = Buffer.from(token);
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const state = () => ({ ...runner.state(), warm: warmth, auth: !!token });
  const body = (req) => new Promise((ok, no) => { let b = ""; req.on("data", (d) => { b += d; if (b.length > 1e5) no(new Error("too large")); }); req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } }); });

  async function control(a) {
    const name = a.campaign ?? runner.campaign;
    switch (a.action) {
      case "start": case "resume": runner.start(name, { minutes: Number(a.minutes) || 0 }); warm(loadCampaign(name), runner.say); break;
      case "pause": runner.pause(); break;
      case "stop": runner.stopNow(); break;
      case "rerun": if (!removeResult(loadCampaign(name), String(a.key ?? ""))) throw new Error("no such result"); runner.say(`result removed, it runs again: ${a.key}`); break;
      case "warm": warm(loadCampaign(name), runner.say); break;
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
      if (p === "/api/state") return send(res, 200, state());
      if (p === "/api/campaigns") return send(res, 200, listCampaigns().map((n) => { try { const o = overview(n); return { name: n, done: o.done, total: o.total, running: !!o.current, about: o.about }; } catch (e) { return { name: n, error: e.message }; } }));
      if (p.startsWith("/api/campaign/")) return send(res, 200, overview(decodeURIComponent(p.slice(14))));
      if (p.startsWith("/api/job/")) return send(res, 200, jobView(decodeURIComponent(p.slice(9)), Number(u.searchParams.get("since") ?? 0)));
      if (p === "/api/stream") {
        // Live, once a second: the runner's state; the campaign when it changed; the running job's status and its new conversation items.
        const name = u.searchParams.get("campaign") || runner.campaign || listCampaigns()[0];
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
        let job = null, since = 0, last = "", lastState = "";
        const tick = () => {
          try {
            const msg = {}, o = overview(name), ov = JSON.stringify({ ...o, current: o.current ? { task: o.current.task, variant: o.current.variant, trial: o.current.trial, job: o.current.job, started: o.current.started } : null });
            if (ov !== last) { msg.overview = JSON.parse(ov); last = ov; }
            const st = JSON.stringify(state()); if (st !== lastState) { msg.state = JSON.parse(st); lastState = st; }
            if ((o.current?.job ?? null) !== job) { job = o.current?.job ?? null; since = 0; msg.reset = true; }
            if (job) mirror(job);                                                // the agent's log, from inside the container, for the next tick
            if (job) { const v = jobView(job, since); since = v.seq; msg.live = { ...v, task: o.current.task, variant: o.current.variant, trial: o.current.trial, startedAt: o.current.started }; }
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
  }).listen(port, host, () => console.log(`Amness Evaluation Studio: http://${host === "0.0.0.0" ? "<this machine>" : host}:${port}/${token ? " (controls need the token)" : " (controls open to anyone who can reach this port)"}`));
  server.runner = runner;
  /** For a restart (an update, a reboot): interrupt the run in progress (it runs again) but keep the saved state, so the next start carries on. */
  server.shutdown = async () => { quitting = true; runner.stopNow(); await runner.done(); server.close(); server.closeAllConnections?.(); };
  return server;
}
