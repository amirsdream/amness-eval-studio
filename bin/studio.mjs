#!/usr/bin/env node
// amness-studio: run evaluation campaigns in resumable sessions, and watch them live in a browser.
//   amness-studio run <campaign> [--minutes 30]     run until done or the time is up (0 = no limit)
//   amness-studio status <campaign>                 progress and results so far
//   amness-studio serve [--port 8090] [--host ...]  the live UI (read-only)
//   amness-studio list                              the campaigns in ./campaigns
// Folders: campaigns/ and subsets/ next to where you run it (or STUDIO_CAMPAIGNS, STUDIO_SUBSETS); results in data/ (or STUDIO_DATA).
import { listCampaigns, loadCampaign, pending, results } from "../src/campaign.mjs";
import { run } from "../src/runner.mjs";
import { serve } from "../src/server.mjs";
import { median, summarize } from "../src/stats.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const opt = (f, d) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : d; };
const fmt = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.round(s / 60)} min`);

if (cmd === "run" && rest[0]) process.exitCode = await run(rest[0], { minutes: Number(opt("--minutes", "30")) });
else if (cmd === "serve") serve({ port: Number(opt("--port", "8090")), host: opt("--host", "0.0.0.0") });
else if (cmd === "list") for (const n of listCampaigns()) console.log(n);
else if (cmd === "status" && rest[0]) {
  const c = loadCampaign(rest[0]), rs = results(c), left = pending(c), per = median(rs.map((r) => r.seconds)) ?? 18 * 60;
  console.log(`${c.name}: ${rs.length} of ${c.runs.length} runs done; about ${fmt(left.length * per)} left`);
  for (const s of summarize(rs, c.variants)) console.log(`  ${s.variant.padEnd(16)} ${s.runs ? `${s.passed}/${s.runs} passed (95% CI ${Math.round(s.ci.lo * 100)}–${Math.round(s.ci.hi * 100)}%)` : "-"}${s.vsBaseline ? `  vs ${c.variants[0]}: +${s.vsBaseline.wins} −${s.vsBaseline.losses} of ${s.vsBaseline.pairs}` : ""}`);
} else { console.log("usage: amness-studio run <campaign> [--minutes 30] | status <campaign> | serve [--port 8090] | list"); process.exitCode = 2; }
