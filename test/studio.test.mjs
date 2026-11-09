import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
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
const { run, Runner } = await import("../src/runner.mjs");
process.env.STUDIO_OFFLINE = "1"; process.env.HARBOR_TASKS = join(root, "no-tasks");

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

test("live view: phase, the conversation (streamed thinking and text, tool calls with their output, edits, guards) and tokens, read incrementally", () => {
  const t = join(root, "data", "jobs", "job-1", "alpha__abc"); mkdirSync(join(t, "agent"), { recursive: true }); mkdirSync(join(t, "verifier"));
  const log = join(t, "agent", "amness.jsonl"), put = (evs) => writeFileSync(log, (existsSync(log) ? readFileSync(log, "utf8") : "") + evs.map((e) => JSON.stringify(e)).join("\n") + "\n");
  put([{ kind: "run", messages: [{ role: "system", content: "be good" }, { role: "user", content: "fix it" }] }, { kind: "phase", phase: "model", step: 0, max: 40 },
    { kind: "thinking", delta: "Let me " }, { kind: "thinking", delta: "look" }, { kind: "text", delta: "Looking" }]);
  let v = jobView("job-1");
  assert.equal(v.phase, "agent"); assert.deepEqual(v.items.map((i) => i.t), ["system", "user", "step", "thinking", "text"]);
  assert.deepEqual([v.items[3].text, v.items[3].live], ["Let me look", true]);
  const seen = v.seq;
  put([{ kind: "model", message: { role: "assistant", content: "Looking around.", tool_calls: [{ id: "c1", function: { name: "sh", arguments: JSON.stringify({ cmd: "ls -la" }) } }] } },
    { kind: "turn", step: 0, prompt: 1000, completion: 50, cached: 400 }, { kind: "assistant", text: "Looking around.", streamed: true },
    { kind: "toolstart", id: "c1", name: "sh", args: JSON.stringify({ cmd: "ls -la" }) }, { kind: "tool", id: "c1", name: "sh", result: "exit=2\nno such file" },
    { kind: "edit", path: "a.py", created: false, added: 2, removed: 1, diff: "+x" }, { kind: "nudge", detail: "act now" }]);
  v = jobView("job-1", seen);
  const byT = Object.fromEntries(v.items.map((i) => [i.t, i]));
  assert.deepEqual(v.items.map((i) => i.t).sort(), ["edit", "guard", "step", "text", "thinking", "tool"]);   // only what changed: no duplicate of the streamed text
  assert.deepEqual([byT.thinking.live, byT.text.text, byT.text.live], [false, "Looking around.", false]);
  assert.deepEqual([byT.tool.args.cmd, byT.tool.status, byT.tool.error], ["ls -la", "done", true]);
  assert.deepEqual(byT.step.usage, { prompt: 1000, cached: 400, completion: 50, reasoning: 0 });
  assert.deepEqual([v.usage.requests, v.usage.prompt, v.usage.cached], [1, 1000, 400]);
  put([{ kind: "result", finished: true, text: "done", steps: 1 }]);
  writeFileSync(join(t, "verifier", "test-stdout.txt"), "1 passed"); writeFileSync(join(t, "result.json"), JSON.stringify({ task_name: "alpha", finished_at: "x", verifier_result: { rewards: { reward: 1 } } }));
  v = jobView("job-1", v.seq);
  assert.equal(v.phase, "done"); assert.deepEqual(v.items.map((i) => i.t), ["end"]); assert.equal(v.final.text, "done"); assert.equal(v.tests, "1 passed"); assert.equal(v.reward, 1);
  assert.equal(jobView("job-1", 0).count, 9);
});

test("runner: saves each result, redoes a setup failure (agent never ran) without recording it, and stops after three in a row", async () => {
  const fake = join(root, "fake-harbor.mjs"), mode = join(root, "mode");
  writeFileSync(fake, `#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync } from "node:fs"; import { join } from "node:path";
const a = process.argv.slice(2), o = a[a.indexOf("-o") + 1], job = a[a.indexOf("--job-name") + 1], task = a[a.indexOf("-i") + 1], t = join(o, job, task + "__x"); mkdirSync(t, { recursive: true });
const m = readFileSync(${JSON.stringify(mode)}, "utf8").trim();
if (m === "slow") { process.on("SIGINT", () => process.exit(130)); await new Promise((ok) => setTimeout(ok, 400)); }
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

test("runner: pause stops after the run in progress; stop now interrupts it without a result; start resumes", async () => {
  writeFileSync(join(root, "campaigns", "demo3.json"), JSON.stringify({ subset: "two", model: "custom/m", variants: { full: [], b: [] } }));
  writeFileSync(join(root, "mode"), "slow");
  const r = new Runner({ say: () => {} }), c = loadCampaign("demo3");
  r.start("demo3"); await new Promise((ok) => setTimeout(ok, 150)); r.pause(); await r.done();
  assert.equal(r.status, "paused"); assert.equal(results(c).length, 1);
  r.start("demo3"); await new Promise((ok) => setTimeout(ok, 150)); r.stopNow(); await r.done();
  assert.equal(r.status, "paused"); assert.equal(results(c).length, 1); assert.ok(r.log.some((l) => /interrupted/.test(l.text)));
  writeFileSync(join(root, "mode"), "ok"); r.start("demo3"); await r.done();
  assert.equal(r.status, "done"); assert.equal(results(c).length, 4);
  assert.throws(() => { r.start("demo3"); r.start("demo"); }, /pause it first/); r.pause(); await r.done();
});

test("server: serves the built UI and the API, and the controls need the token", async () => {
  const { serve } = await import("../src/server.mjs");
  const ui = new URL("../ui/dist/index.html", import.meta.url).pathname; if (!existsSync(ui)) { mkdirSync(join(ui, ".."), { recursive: true }); writeFileSync(ui, "<!doctype html><div id=root></div>"); }
  const srv = serve({ port: 0, host: "127.0.0.1", token: "s3cret", resume: false }); await new Promise((ok) => srv.once("listening", ok));
  const base = `http://127.0.0.1:${srv.address().port}`, post = (body, token) => fetch(base + "/api/control", { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-studio-token": token } : {}) }, body: JSON.stringify(body) });
  try {
    const page = await fetch(base + "/"); assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8"); assert.match(await page.text(), /^<!doctype html>/i);
    assert.match(await (await fetch(base + "/run/anything")).text(), /^<!doctype html>/i);   // the app's own routes
    assert.ok((await (await fetch(base + "/api/campaigns")).json()).some((c) => c.name === "demo"));
    assert.equal((await fetch(base + "/api/campaigns", { method: "POST" })).status, 405);
    assert.equal((await fetch(base + "/missing.js")).status, 404);
    assert.equal((await post({ action: "pause" })).status, 401); assert.equal((await post({ action: "pause" }, "wrong")).status, 401);
    assert.equal((await fetch(base + "/api/control", { method: "POST", headers: { "x-studio-token": "s3cret" }, body: "action=pause" })).status, 415);
    const c = loadCampaign("demo"), before = results(c).length;
    const ok = await post({ action: "rerun", campaign: "demo", key: "alpha|full|1" }, "s3cret"); assert.equal(ok.status, 200);
    assert.equal(results(c).length, before - 1); assert.equal(pending(c)[0].task, "alpha");
    assert.equal((await post({ action: "fly" }, "s3cret")).status, 400);
    const st = await (await fetch(base + "/api/state")).json(); assert.equal(st.auth, true);
  } finally { srv.close(); }
});
