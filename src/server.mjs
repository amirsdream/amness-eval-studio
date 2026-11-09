// The studio's web server: the UI (ui/), a JSON API, and a live stream (Server-Sent Events) that pushes the campaign state and the
// running agent's new events every two seconds. Read-only: nothing here can start, stop or change a campaign.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { currentRun, listCampaigns, loadCampaign, pending, results } from "./campaign.mjs";
import { jobView } from "./live.mjs";
import { median, summarize } from "./stats.mjs";

const UI = resolve(new URL("../ui", import.meta.url).pathname);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

/** The whole picture of one campaign, small enough to push every two seconds. */
export function overview(name) {
  const c = loadCampaign(name), rs = results(c), left = pending(c), cur = currentRun(c), per = median(rs.map((r) => r.seconds)) ?? 18 * 60;
  return {
    name, about: c.plan.about ?? "", model: c.plan.model, dataset: c.plan.dataset ?? "terminal-bench@2.0", tasks: c.tasks, variants: c.variants, total: c.runs.length,
    done: rs.length, left: left.length, etaSeconds: left.length * per, perRunSeconds: per, next: left[0] ?? null,
    summary: summarize(rs, c.variants), results: rs, current: cur ? { ...jobView(cur.job, Number.MAX_SAFE_INTEGER), ...cur } : null,   // the plan's task and variant win over what the job folder knows so far
  };
}

export function serve({ port = 8090, host = "0.0.0.0" } = {}) {
  let server;
  const send = (res, code, body, type = "application/json") => { res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  server = createServer((req, res) => {
    const u = new URL(req.url, "http://x"), p = u.pathname;
    try {
      if (req.method !== "GET") return send(res, 405, { error: "read-only" });
      if (p === "/api/campaigns") return send(res, 200, listCampaigns().map((n) => { try { const o = overview(n); return { name: n, done: o.done, total: o.total, running: !!o.current }; } catch (e) { return { name: n, error: e.message }; } }));
      if (p.startsWith("/api/campaign/")) return send(res, 200, overview(decodeURIComponent(p.slice(14))));
      if (p.startsWith("/api/job/")) return send(res, 200, jobView(decodeURIComponent(p.slice(9)), Number(u.searchParams.get("since") ?? -1)));
      if (p === "/api/stream") {
        // Live: the campaign overview, plus the running job's new events since the last push.
        const name = u.searchParams.get("campaign") ?? listCampaigns()[0];
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        let job = null, since = -1;
        const tick = () => {
          try {
            const o = overview(name);
            if (o.current?.job !== job) { job = o.current?.job ?? null; since = -1; }
            const live = job ? jobView(job, since) : null; if (live) since = live.lastIndex;
            res.write(`data: ${JSON.stringify({ overview: { ...o, current: o.current ? { ...o.current, events: undefined } : null }, live })}\n\n`);
          } catch (e) { res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`); }
        };
        tick(); const t = setInterval(tick, 2000); req.on("close", () => clearInterval(t)); return;
      }
      const f = join(UI, p === "/" ? "index.html" : p.replace(/^\/+/, ""));
      if (!f.startsWith(UI) || !existsSync(f)) return send(res, 404, "not found", "text/plain");
      return send(res, 200, readFileSync(f), TYPES[extname(f)] ?? "application/octet-stream");
    } catch (e) { return send(res, 500, { error: e.message }); }
  }).listen(port, host, () => console.log(`Amness Evaluation Studio: http://${host === "0.0.0.0" ? "<this machine>" : host}:${port}/ (read-only)`));
  return server;
}
