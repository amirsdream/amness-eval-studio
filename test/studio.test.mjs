import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "studio-"));
process.env.STUDIO_ROOT = root;
mkdirSync(join(root, "campaigns")); mkdirSync(join(root, "subsets"));
writeFileSync(join(root, "subsets", "two.txt"), "# two tasks\nalpha\nbeta\n");
writeFileSync(join(root, "campaigns", "demo.json"), JSON.stringify({ subset: "two", model: "custom/m", variants: { full: [], "no-x": ["--ak", "off=x"] } }));
const { loadCampaign, results, pending } = await import("../src/campaign.mjs");
const { wilson, summarize } = await import("../src/stats.mjs");
const { jobView } = await import("../src/live.mjs");
const { run } = await import("../src/runner.mjs");

test("stats: Wilson interval and paired wins/losses against the first variant", () => {
  const w = wilson(4, 8); assert.ok(w.lo > 0.15 && w.lo < 0.25 && w.hi > 0.75 && w.hi < 0.85, JSON.stringify(w));
  const rows = [{ task: "a", trial: 1, variant: "full", reward: 1 }, { task: "b", trial: 1, variant: "full", reward: 0 }, { task: "a", trial: 1, variant: "v", reward: 0 }, { task: "b", trial: 1, variant: "v", reward: 1, exception: null }];
  const [f, v] = summarize(rows, ["full", "v"]);
  assert.deepEqual([f.passed, f.runs, f.vsBaseline], [1, 2, null]); assert.deepEqual(v.vsBaseline, { pairs: 2, wins: 1, losses: 1 });
});

test("campaign: runs go task by task with every variant together", () => {
  const c = loadCampaign("demo");
  assert.deepEqual(c.runs.map((r) => `${r.task}/${r.variant}`), ["alpha/full", "alpha/no-x", "beta/full", "beta/no-x"]);
});

test("live view: phase, the agent's events and tokens, and the tests' output, read from a Harbor job folder", () => {
  const t = join(root, "data", "jobs", "job-1", "alpha__abc"); mkdirSync(join(t, "agent"), { recursive: true }); mkdirSync(join(t, "verifier"));
  const ev = [{ kind: "turn", step: 0, prompt: 1000, completion: 50, cached: 0 }, { kind: "toolstart", name: "sh", args: JSON.stringify({ cmd: "ls -la" }) }, { kind: "tool", name: "sh", result: "exit=0\nfile" },
    { kind: "edit", path: "a.py", created: false, added: 2, removed: 1 }, { kind: "nudge", detail: "act now" }, { kind: "text", delta: "skip me" }, { kind: "turn", step: 1, prompt: 1500, completion: 60, cached: 900 }];
  writeFileSync(join(t, "agent", "amness.jsonl"), ev.map((e) => JSON.stringify(e)).join("\n") + "\n");
  let v = jobView("job-1");
  assert.equal(v.phase, "agent"); assert.deepEqual(v.events.map((e) => e.k), ["tool", "result", "edit", "guard"]); assert.equal(v.events[0].text, "ls -la");
  assert.deepEqual([v.usage.requests, v.usage.prompt, v.usage.cached], [2, 2500, 900]);
  writeFileSync(join(t, "agent", "amness.jsonl"), readFileSync(join(t, "agent", "amness.jsonl"), "utf8") + JSON.stringify({ kind: "result", finished: true, text: "done", steps: 2 }) + "\n");
  writeFileSync(join(t, "verifier", "test-stdout.txt"), "1 passed"); writeFileSync(join(t, "result.json"), JSON.stringify({ task_name: "alpha", finished_at: "x", verifier_result: { rewards: { reward: 1 } } }));
  v = jobView("job-1", 3);
  assert.equal(v.phase, "done"); assert.deepEqual(v.events.map((e) => e.k), ["end"]); assert.equal(v.final.text, "done"); assert.equal(v.tests, "1 passed"); assert.equal(v.reward, 1);
});

test("runner: saves each result, redoes a setup failure (agent never ran) without recording it, and stops after three in a row", async () => {
  const fake = join(root, "fake-harbor.mjs"), mode = join(root, "mode");
  writeFileSync(fake, `#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync } from "node:fs"; import { join } from "node:path";
const a = process.argv.slice(2), o = a[a.indexOf("-o") + 1], job = a[a.indexOf("--job-name") + 1], task = a[a.indexOf("-i") + 1], t = join(o, job, task + "__x"); mkdirSync(t, { recursive: true });
const m = readFileSync(${JSON.stringify(mode)}, "utf8").trim();
writeFileSync(join(t, "result.json"), JSON.stringify(m === "setup" ? { exception_info: { exception_type: "RuntimeError", exception_message: "docker: compose missing" } }
  : { agent_execution: {}, agent_result: { n_input_tokens: 123 }, verifier_result: { rewards: { reward: task === "alpha" ? 1 : 0 } } }));
`); chmodSync(fake, 0o755); process.env.HARBOR = fake;
  const said = []; const c = loadCampaign("demo");
  writeFileSync(mode, "ok"); await run("demo", { minutes: 0, say: (m) => said.push(m) });
  assert.deepEqual(results(c).map((r) => [r.task, r.variant, r.reward, r.tokensIn]), [["alpha", "full", 1, 123], ["alpha", "no-x", 1, 123], ["beta", "full", 0, 123], ["beta", "no-x", 0, 123]]);
  writeFileSync(join(root, "campaigns", "demo2.json"), JSON.stringify({ subset: "two", model: "custom/m", variants: { full: [] } }));
  writeFileSync(mode, "setup"); const code = await run("demo2", { minutes: 0, say: (m) => said.push(m) });
  assert.equal(code, 1); assert.equal(results(loadCampaign("demo2")).length, 0); assert.equal(pending(loadCampaign("demo2")).length, 2);
  assert.ok(said.some((s) => /setup failed: RuntimeError: docker: compose missing/.test(s)) && said.some((s) => /three runs in a row/.test(s)));
});
