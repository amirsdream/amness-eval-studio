// Runs a campaign: one Harbor run at a time, in order, saving each result as soon as it ends. Resumable: a stop anywhere loses at most the run in progress.
// A run where Harbor failed before the agent started (Docker, the image, installing the agent) is not a result about the agent: it is redone,
// and three such failures in a row stop the campaign so a broken setup does not burn through the list.
// The Runner is driven by the CLI (`run`) or by the studio's server (start, pause after this run, stop now, resume); a lock file keeps it to one at a time.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { addResult, currentRun, loadCampaign, lock, paths, pending, results, setCurrent, unlock } from "./campaign.mjs";
import { median } from "./stats.mjs";
import { trialDir } from "./live.mjs";
import { buildArgs, effectiveSettings, runSetup } from "./setup.mjs";

export const fmt = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.round(s / 60)} min`);
const adapters = resolve(new URL("../adapters/harbor", import.meta.url).pathname);

/** One Harbor run of one task with one variant. Resolves with the result, or undefined when there is none (interrupted, or a setup failure). */
async function runOne(c, r, say, onChild) {
  const job = `${c.name}-${r.variant}-${r.task}-t${r.trial}-${Date.now()}`;
  const args = ["run", "-d", c.plan.dataset ?? "terminal-bench@2.0", "-i", r.task, "-n", "1", "-a", c.plan.agent ?? "amness_agent:Amness", "-m", c.plan.model,
    "-o", paths.jobs, "--job-name", job, ...buildArgs(c, r).args];
  const setup = await runSetup(c, r, args).catch((e) => ({ error: e.message }));   // what, which version, how and where: recorded with the result
  const t0 = Date.now();
  setCurrent(c, { ...r, job, started: new Date().toISOString(), limit: c.plan.limitSeconds ?? null, setup });
  return new Promise((ok) => {
    const p = spawn(process.env.HARBOR ?? "harbor", args, { env: { ...process.env, PYTHONPATH: [adapters, process.env.PYTHONPATH].filter(Boolean).join(":") }, stdio: ["ignore", "ignore", "inherit"] });
    onChild(p);
    p.on("error", (e) => { say(`  could not start harbor: ${e.message}`); setCurrent(c, null); ok(undefined); });
    p.on("close", () => {
      setCurrent(c, null);
      const t = trialDir(job); if (!t || !existsSync(join(t, "result.json"))) return ok(undefined);
      let d; try { d = JSON.parse(readFileSync(join(t, "result.json"), "utf8")); } catch { return ok(undefined); }
      const a = d.agent_result ?? {};
      if (d.exception_info?.exception_type === "CancelledError") { say("  cancelled (Harbor was stopped): not a result"); return ok(undefined); }
      if (d.exception_info && !d.agent_execution) { say(`  setup failed: ${d.exception_info.exception_type}: ${String(d.exception_info.exception_message ?? "").split("\n")[0].slice(0, 200)}`); return ok(undefined); }
      ok({ ...r, reward: d.verifier_result?.rewards?.reward ?? 0, exception: d.exception_info?.exception_type ?? null, tokensIn: a.n_input_tokens ?? null, tokensCached: a.n_cache_tokens ?? null,
        tokensOut: a.n_output_tokens ?? null, cost: a.cost_usd ?? null, seconds: Math.round((Date.now() - t0) / 1000), job, at: new Date().toISOString(), setup: { ...setup, effective: effectiveSettings(job) } });
    });
  });
}

/**
 * Drives one campaign at a time. `status`: idle, running, pausing (stops after the run in progress, or now when asked), paused, done, error.
 * Emits "change" with the state after every change, and "result" with each saved result.
 */
export class Runner extends EventEmitter {
  constructor({ say = console.log } = {}) {
    super();
    this.log = []; this.campaign = null; this.status = "idle"; this.message = ""; this.until = null; this.child = null; this.interrupted = false; this.loop = null;
    this.say = (m) => { say(m); this.log.push({ at: new Date().toISOString(), text: m }); if (this.log.length > 200) this.log.shift(); this.emit("change", this.state()); };
  }

  state() { return { campaign: this.campaign, status: this.status, message: this.message, until: this.until, log: this.log.slice(-50) }; }
  set(status, message = this.message) { this.status = status; this.message = message; this.emit("change", this.state()); }

  /** Start or resume `name`; `minutes` > 0 ends the session when the next run would not finish in time. */
  start(name, { minutes = 0 } = {}) {
    if (this.loop && this.campaign !== name) throw new Error(`${this.campaign} is running: pause it first`);
    loadCampaign(name);                                                    // fails early on a bad name or file
    this.campaign = name; this.until = minutes > 0 ? Date.now() + minutes * 60_000 : null;
    this.set("running", "");
    if (!this.loop) this.loop = this.#loop().finally(() => { this.loop = null; });
  }

  /** Stop after the run in progress. */
  pause() { if (this.loop) this.set("pausing", "pausing after this run"); }

  /** Stop now: the run in progress is interrupted (Harbor removes its containers) and runs again on resume. */
  stopNow() {
    if (!this.loop) return;
    this.set("pausing", "stopping the run in progress");
    const p = this.child; if (!p) return;
    this.interrupted = true; p.kill("SIGINT");
    setTimeout(() => { if (p.exitCode === null) p.kill("SIGTERM"); }, 30_000).unref();
    setTimeout(() => { if (p.exitCode === null) p.kill("SIGKILL"); }, 90_000).unref();
  }

  /** Resolves when the loop has ended. */
  async done() { await this.loop; }

  async #loop() {
    const name = this.campaign;
    let c = loadCampaign(name), noResult = 0;
    const held = lock(c); if (held) { this.set("error", `already running in process ${held}`); return; }
    if (currentRun(c)) setCurrent(c, null);                                // left over from a stop in the middle of a run
    try {
      for (;;) {
        c = loadCampaign(name);                                            // edits to the campaign file apply from the next run
        if (this.status !== "running") { this.set("paused", "paused"); return; }
        const next = pending(c)[0], rs = results(c);
        if (!next) { this.say("the campaign is complete"); this.set("done", "the campaign is complete"); return; }
        const expect = median(rs.map((r) => r.seconds)) ?? 18 * 60;
        if (this.until && Date.now() + expect * 1000 > this.until) { this.until = null; this.say(`session time is up (the next run takes about ${fmt(expect)})`); this.set("paused", "session time is up"); return; }
        this.say(`▶ ${next.task} · ${next.variant} · trial ${next.trial}   (${rs.length + 1} of ${c.runs.length}; about ${fmt(expect)})`);
        const r = await runOne(c, next, this.say, (p) => { this.child = p; });
        this.child = null;
        if (!r) {
          if (this.interrupted) { this.interrupted = false; this.say("  interrupted: it will run again"); continue; }
          this.say("  no result: it will run again");
          if (++noResult >= 3) { this.say("three runs in a row gave no result: stopping (see the job folder for the reason)"); this.set("error", "three runs in a row gave no result"); return; }
          continue;
        }
        noResult = 0; addResult(c, r); this.emit("result", r);
        this.say(`  ${r.reward >= 1 ? "passed" : "failed"}${r.exception ? ` (${r.exception})` : ""} in ${fmt(r.seconds)}, ${r.tokensIn ?? "?"} tokens sent`);
      }
    } catch (e) { this.say(`error: ${e.message}`); this.set("error", e.message); }
    finally { unlock(c); }
  }
}

/** The CLI: run until the campaign is done, the time is up (`minutes`, 0 = no limit), or Ctrl-C (once: after this run; twice: now). Exit code 1 on an error stop. */
export async function run(name, { minutes = 30, say = console.log } = {}) {
  const r = new Runner({ say });
  const stop = () => { if (r.status === "pausing") return r.stopNow(); r.pause(); say("stopping after this run (again to stop now; an interrupted run is redone next time)"); };
  const term = () => r.pause();
  process.on("SIGINT", stop); process.on("SIGTERM", term);
  try { r.start(name, { minutes }); await r.done(); } finally { process.off("SIGINT", stop); process.off("SIGTERM", term); }
  return r.status === "error" ? 1 : 0;
}
