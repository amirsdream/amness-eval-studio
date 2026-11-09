#!/usr/bin/env node
// amness-studio: run evaluation campaigns in resumable sessions, and watch them live in a browser.
//   amness-studio run <campaign> [--minutes 30]     run until done or the time is up (0 = no limit)
//   amness-studio status <campaign>                 progress and results so far
//   amness-studio serve [--port 8090] [--host ...]  the live UI, and the runner you control from it (STUDIO_TOKEN: the token the controls need)
//   amness-studio warm <campaign>                   download the tasks and pull their images now
//   amness-studio checks <campaign>                 harness checks over the finished runs (feedback on the agent's harness itself)
//   amness-studio list                              the campaigns in ./campaigns
// Folders: campaigns/ and subsets/ next to where you run it (or STUDIO_CAMPAIGNS, STUDIO_SUBSETS); results in data/ (or STUDIO_DATA).
import { listCampaigns, loadCampaign, pending, results } from "../src/campaign.mjs";
import { run } from "../src/runner.mjs";
import { serve } from "../src/server.mjs";
import { warm } from "../src/cache.mjs";
import { campaignFindings } from "../src/findings.mjs";
import { median, summarize } from "../src/stats.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const opt = (f, d) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : d; };
const fmt = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.round(s / 60)} min`);

if (cmd === "run" && rest[0]) process.exitCode = await run(rest[0], { minutes: Number(opt("--minutes", "30")) });
else if (cmd === "serve") {
  const srv = serve({ port: Number(opt("--port", "8090")), host: opt("--host", "0.0.0.0") });
  let once = false;
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, async () => { if (once) process.exit(130); once = true; await srv.shutdown(); process.exit(0); });
}
else if (cmd === "warm" && rest[0]) console.log((await warm(loadCampaign(rest[0]), console.log)).message);
else if (cmd === "checks" && rest[0]) {
  // Harness checks across the campaign's finished runs: the feedback on Amness itself.
  const c = loadCampaign(rest[0]), rs = results(c), checks = campaignFindings(rs);
  console.log(`${c.name}: harness checks over ${rs.length} finished runs${checks.length ? "" : ": nothing fired"}`);
  for (const k of checks) {
    console.log(`\n[${k.kind}] ${k.title}: ${k.runs.length} of ${rs.length} runs (${k.count} times)\n  ${k.why}`);
    for (const r of k.runs.slice(0, 6)) console.log(`  - ${r.task} · ${r.variant} · t${r.trial} (${r.passed ? "passed" : "failed"}) ×${r.count}`);
    if (k.example) console.log(`  e.g.${k.example.step ? ` step ${k.example.step}:` : ""} ${k.example.text}`);
  }
}
else if (cmd === "list") for (const n of listCampaigns()) console.log(n);
else if (cmd === "status" && rest[0]) {
  const c = loadCampaign(rest[0]), rs = results(c), left = pending(c), per = median(rs.map((r) => r.seconds)) ?? 18 * 60;
  console.log(`${c.name}: ${rs.length} of ${c.runs.length} runs done; about ${fmt(left.length * per)} left`);
  for (const s of summarize(rs, c.variants)) console.log(`  ${s.variant.padEnd(16)} ${s.runs ? `${s.passed}/${s.runs} passed (95% CI ${Math.round(s.ci.lo * 100)}–${Math.round(s.ci.hi * 100)}%)` : "-"}${s.vsBaseline ? `  vs ${c.variants[0]}: +${s.vsBaseline.wins} −${s.vsBaseline.losses} of ${s.vsBaseline.pairs}` : ""}`);
} else { console.log("usage: amness-studio run <campaign> [--minutes 30] | status <campaign> | serve [--port 8090] | warm <campaign> | checks <campaign> | list"); process.exitCode = 2; }
