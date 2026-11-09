// Warm the caches a campaign needs before its runs ask for them: the task files (Harbor's task cache) and each task's prebuilt Docker image.
// The first run of a task otherwise waits for the image download; with this it starts at once. Docker keeps the images afterwards.
// The agent's own install is cached by the Harbor adapter (a bundle of Node and Amness built once per package: see adapters/harbor).
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const sh = (cmd, args, timeout = 30 * 60_000) => new Promise((ok) => execFile(cmd, args, { timeout, maxBuffer: 8 << 20 }, (err, stdout, stderr) => ok({ ok: !err, out: String(stdout), err: String(stderr || err?.message || "") })));
const tasksDir = () => process.env.HARBOR_TASKS ?? join(homedir(), ".cache", "harbor", "tasks");

/** task name -> its task.toml in Harbor's cache (content-addressed folders: <digest>/<task>/task.toml). */
function cachedTasks() {
  const m = new Map(), d = tasksDir(); if (!existsSync(d)) return m;
  for (const digest of readdirSync(d)) { let names = []; try { names = readdirSync(join(d, digest)); } catch { continue; } for (const n of names) if (existsSync(join(d, digest, n, "task.toml"))) m.set(n, join(d, digest, n, "task.toml")); }
  return m;
}
const imageOf = (toml) => { try { return /^\s*docker_image\s*=\s*"([^"]+)"/m.exec(readFileSync(toml, "utf8"))?.[1] ?? null; } catch { return null; } };

/** State of the warm-up, shown in the UI: one row per task (image name, ready or not). */
export const warmth = { busy: false, campaign: null, tasks: [], message: "" };

/** Download missing task files, then pull the images that are not here yet, in campaign order. Safe to call often: one warm-up at a time. */
export async function warm(c, say = () => {}) {
  if (warmth.busy) return warmth;
  Object.assign(warmth, { busy: true, campaign: c.name, message: "checking tasks" });
  try {
    let have = cachedTasks();
    if (c.tasks.some((t) => !have.has(t)) && !process.env.STUDIO_OFFLINE) {
      warmth.message = `downloading the task files of ${c.plan.dataset ?? "terminal-bench@2.0"}`;
      const r = await sh(process.env.HARBOR ?? "harbor", ["download", c.plan.dataset ?? "terminal-bench@2.0", "--cache"]);
      if (!r.ok) say(`warm-up: could not download the tasks: ${r.err.split("\n").slice(-2).join(" ").slice(0, 200)}`);
      have = cachedTasks();
    }
    warmth.tasks = c.tasks.map((t) => ({ task: t, image: have.has(t) ? imageOf(have.get(t)) : null, ready: false }));
    for (const row of warmth.tasks) {
      if (!row.image) { row.ready = have.has(row.task) ? "build" : false; continue; }   // no prebuilt image: Harbor builds it, and Docker caches the layers
      row.ready = (await sh("docker", ["image", "inspect", "--format", "{{.Id}}", row.image], 30_000)).ok;
    }
    for (const row of warmth.tasks) {
      if (row.ready !== false || !row.image) continue;
      warmth.message = `pulling ${row.image}`; row.pulling = true;
      const r = await sh("docker", ["pull", "--quiet", row.image]);
      row.pulling = false; row.ready = r.ok; if (!r.ok) { row.error = r.err.slice(0, 200); say(`warm-up: could not pull ${row.image}: ${row.error}`); }
    }
    warmth.message = `${warmth.tasks.filter((r) => r.ready).length} of ${warmth.tasks.length} task images ready`;
  } catch (e) { warmth.message = `warm-up failed: ${e.message}`; }
  finally { warmth.busy = false; }
  return warmth;
}
