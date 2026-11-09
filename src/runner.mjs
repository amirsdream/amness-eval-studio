// Runs a campaign: one Harbor run at a time, in order, saving each result as soon as it ends. Resumable: a stop anywhere loses at most the run in progress.
// A run where Harbor failed before the agent started (Docker, the image, installing the agent) is not a result about the agent: it is redone,
// and three such failures in a row stop the campaign so a broken setup does not burn through the list.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { addResult, currentRun, loadCampaign, paths, pending, results, setCurrent } from "./campaign.mjs";
import { median } from "./stats.mjs";
import { trialDir } from "./live.mjs";

const fmt = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.round(s / 60)} min`);
const adapters = resolve(new URL("../adapters/harbor", import.meta.url).pathname);

/** One Harbor run of one task with one variant. Resolves with the result, or undefined when there is none (interrupted, or a setup failure). */
function runOne(c, r, say) {
  const job = `${c.name}-${r.variant}-${r.task}-t${r.trial}-${Date.now()}`;
  const args = ["run", "-d", c.plan.dataset ?? "terminal-bench@2.0", "-i", r.task, "-n", "1", "-a", c.plan.agent ?? "amness_agent:Amness", "-m", c.plan.model,
    "-o", paths.jobs, "--job-name", job, ...(c.plan.args ?? []), ...c.plan.variants[r.variant]];
  const t0 = Date.now();
  setCurrent(c, { ...r, job, started: new Date().toISOString(), limit: c.plan.limitSeconds ?? null });
  return new Promise((ok) => {
    const p = spawn(process.env.HARBOR ?? "harbor", args, { env: { ...process.env, PYTHONPATH: [adapters, process.env.PYTHONPATH].filter(Boolean).join(":") }, stdio: ["ignore", "ignore", "inherit"] });
    p.on("error", (e) => { say(`  could not start harbor: ${e.message}`); setCurrent(c, null); ok(undefined); });
    p.on("close", () => {
      setCurrent(c, null);
      const t = trialDir(job); if (!t || !existsSync(join(t, "result.json"))) return ok(undefined);
      const d = JSON.parse(readFileSync(join(t, "result.json"), "utf8")), a = d.agent_result ?? {};
      if (d.exception_info && !d.agent_execution) { say(`  setup failed: ${d.exception_info.exception_type}: ${String(d.exception_info.exception_message ?? "").split("\n")[0].slice(0, 200)}`); return ok(undefined); }
      ok({ ...r, reward: d.verifier_result?.rewards?.reward ?? 0, exception: d.exception_info?.exception_type ?? null, tokensIn: a.n_input_tokens ?? null, tokensCached: a.n_cache_tokens ?? null,
        tokensOut: a.n_output_tokens ?? null, cost: a.cost_usd ?? null, seconds: Math.round((Date.now() - t0) / 1000), job, at: new Date().toISOString() });
    });
  });
}

/** Run until the campaign is done, the time is up (`minutes`, 0 = no limit), or a stop signal; a run is started only if it is expected to finish in time. */
export async function run(name, { minutes = 30, say = console.log } = {}) {
  const c = loadCampaign(name), budget = minutes * 60, start = Date.now();
  if (currentRun(c)) setCurrent(c, null);                                     // left over from a stop in the middle of a run
  let stopping = false, noResult = 0;
  const stop = () => { if (stopping) process.exit(130); stopping = true; say("stopping after this run (again to stop now; an interrupted run is redone next time)"); };
  process.on("SIGINT", stop); process.on("SIGTERM", () => { stopping = true; });
  for (;;) {
    const next = pending(c)[0], rs = results(c);
    if (!next) { say("the campaign is complete"); break; }
    const used = (Date.now() - start) / 1000, expect = median(rs.map((r) => r.seconds)) ?? 18 * 60;
    if (budget > 0 && used + expect > budget) { say(`session time is up (${fmt(used)} used; the next run takes about ${fmt(expect)})`); break; }
    if (stopping) break;
    say(`▶ ${next.task} · ${next.variant} · trial ${next.trial}   (${rs.length + 1} of ${c.runs.length}; about ${fmt(expect)})`);
    const r = await runOne(c, next, say);
    if (!r) { say("  no result: it will run again"); if (stopping) break; if (++noResult >= 3) { say("three runs in a row gave no result: stopping (see the job folder for the reason)"); return 1; } continue; }
    noResult = 0; addResult(c, r);
    say(`  ${r.reward >= 1 ? "passed" : "failed"}${r.exception ? ` (${r.exception})` : ""} in ${fmt(r.seconds)}, ${r.tokensIn ?? "?"} tokens sent`);
  }
  return 0;
}
