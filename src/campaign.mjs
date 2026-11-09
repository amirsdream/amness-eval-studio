// A campaign: a fixed list of runs (task x variant x trial) for one agent and model, defined in campaigns/<name>.json.
// Results are one JSON line per finished run in <data>/<name>/results.jsonl; the run in progress is <data>/<name>/current.json.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export const paths = {
  root: process.env.STUDIO_ROOT ?? process.cwd(),
  get campaigns() { return process.env.STUDIO_CAMPAIGNS ?? join(this.root, "campaigns"); },
  get subsets() { return process.env.STUDIO_SUBSETS ?? join(this.root, "subsets"); },
  get data() { return process.env.STUDIO_DATA ?? join(this.root, "data"); },
  get jobs() { return join(this.data, "jobs"); },
};

export function listCampaigns() {
  if (!existsSync(paths.campaigns)) return [];
  return readdirSync(paths.campaigns).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
}

/** The campaign's plan, its tasks, and every run in order: task by task, all variants of a task together, then the next trial round. */
export function loadCampaign(name) {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`bad campaign name: ${name}`);
  const plan = JSON.parse(readFileSync(join(paths.campaigns, `${name}.json`), "utf8"));
  const tasks = readFileSync(join(paths.subsets, `${plan.subset}.txt`), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const variants = Object.keys(plan.variants), runs = [];
  for (let trial = 1; trial <= (plan.trials ?? 1); trial++) for (const task of tasks) for (const variant of variants) runs.push({ task, variant, trial });
  const dir = join(paths.data, name); mkdirSync(dir, { recursive: true });
  return { name, plan, tasks, variants, runs, dir, log: join(dir, "results.jsonl"), current: join(dir, "current.json") };
}

export const runKey = (r) => `${r.task}|${r.variant}|${r.trial}`;
export function results(c) { return existsSync(c.log) ? readFileSync(c.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; }
export function addResult(c, r) { appendFileSync(c.log, JSON.stringify(r) + "\n"); }
export function pending(c) { const have = new Set(results(c).map(runKey)); return c.runs.filter((r) => !have.has(runKey(r))); }
export function currentRun(c) { try { return existsSync(c.current) ? JSON.parse(readFileSync(c.current, "utf8")) : null; } catch { return null; } }
export function setCurrent(c, r) { if (r) writeFileSync(c.current, JSON.stringify(r)); else rmSync(c.current, { force: true }); }
