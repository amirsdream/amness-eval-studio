// Amness Evaluation Studio UI: one live stream (Server-Sent Events) carries the campaign and the running agent's new events.
// Everything from a run (task output, agent text) is untrusted: it is only ever set as text, never as HTML.
"use strict";
const $ = (id) => document.getElementById(id);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v; else if (k === "text") el.textContent = v; else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat()) if (c !== undefined && c !== null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
/** Replace an element's children, skipping empty slots (replaceChildren would print "null"). */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
const fmtDur = (s) => { s = Math.max(0, Math.round(s)); return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`; };
const fmtNum = (n) => (n === null || n === undefined || !Number.isFinite(n) ? "–" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
const pct = (x) => (x === null || x === undefined ? "–" : Math.round(x * 100) + "%");
const outcome = (r) => (r.reward >= 1 ? "pass" : r.exception === "AgentTimeoutError" ? "timeout" : "fail");
const ICON = { tool: "▸", result: "↳", edit: "✎", say: "💬", guard: "⚑", steer: "↪", end: "■" };

let campaign = new URLSearchParams(location.search).get("campaign") || "", ov = null, live = { job: null, events: [], usage: null }, autoScroll = true, es = null;

async function start() {
  const list = await fetch("/api/campaigns").then((r) => r.json()).catch(() => []);
  fill($("campaign"), ...list.map((c) => h("option", { value: c.name, selected: c.name === campaign || undefined, text: `${c.name}${c.total ? ` (${c.done}/${c.total})` : ""}${c.running ? " · running" : ""}` })));
  if (!campaign && list.length) campaign = (list.find((c) => c.running) ?? list[0]).name;
  $("campaign").value = campaign;
  $("campaign").onchange = () => { campaign = $("campaign").value; history.replaceState(null, "", `?campaign=${encodeURIComponent(campaign)}`); connect(); };
  connect();
  setInterval(() => renderElapsed(), 1000);
}

function connect() {
  es?.close(); live = { job: null, events: [], usage: null };
  es = new EventSource(`/api/stream?campaign=${encodeURIComponent(campaign)}`);
  es.onopen = () => { $("conn").textContent = "live"; $("conn").className = "conn on"; };
  es.onerror = () => { $("conn").textContent = "reconnecting…"; $("conn").className = "conn off"; };
  es.onmessage = (m) => {
    const d = JSON.parse(m.data); if (d.error) { fill($("progress"), h("div", { class: "empty", text: d.error })); return; }
    ov = d.overview;
    if (d.live) {
      if (d.live.job !== live.job) live = { job: d.live.job, events: [] };
      live.events.push(...d.live.events); if (live.events.length > 800) live.events.splice(0, live.events.length - 800);
      Object.assign(live, { phase: d.live.phase, usage: d.live.usage, step: d.live.step, final: d.live.final, tests: d.live.tests, stderr: d.live.stderr, exception: d.live.exception });
    } else live = { job: null, events: [] };
    render();
  };
}

function render() {
  if (!ov) return;
  renderProgress(); renderLive(); renderVariants(); renderGrid(); renderHistory();
}

function renderProgress() {
  const p = ov.total ? ov.done / ov.total : 0;
  fill($("progress"), 
    h("h2", { text: ov.name }), ov.about ? h("div", { class: "muted small", text: ov.about }) : null,
    h("div", { class: "bar" }, h("i", { style: `width:${(p * 100).toFixed(1)}%` })),
    h("div", { class: "kv" },
      h("span", {}, h("b", { text: `${ov.done} of ${ov.total}` }), " runs done"),
      h("span", {}, "about ", h("b", { text: fmtDur(ov.etaSeconds) }), " left"),
      h("span", {}, "≈ ", h("b", { text: fmtDur(ov.perRunSeconds) }), " per run"),
      h("span", {}, "model ", h("b", { class: "mono", text: ov.model })),
      h("span", {}, "dataset ", h("b", { class: "mono", text: ov.dataset })),
      ov.next && !ov.current ? h("span", { class: "muted", text: `next: ${ov.next.task} · ${ov.next.variant}` }) : null));
}

function spark(values) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("class", "spark"); svg.setAttribute("viewBox", "0 0 300 36"); svg.setAttribute("preserveAspectRatio", "none");
  if (values.length < 2) return svg;
  const mx = Math.max(1, ...values), pts = values.map((v, i) => [(i / (values.length - 1)) * 300, 34 - (v / mx) * 32]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = document.createElementNS(svg.namespaceURI, "path"); area.setAttribute("class", "area"); area.setAttribute("d", `${line} L300,36 L0,36 Z`);
  const path = document.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", line); svg.append(area, path); return svg;
}

function renderLive() {
  const c = ov.current;
  if (!c) { fill($("live"), h("h2", { text: "Now" }), h("div", { class: "empty", text: ov.left ? "No run in progress: the campaign is paused or between runs." : "The campaign is complete." })); return; }
  const order = ["setting up", "agent", "testing", "done"], at = order.indexOf(live.phase ?? c.phase);
  const u = live.usage ?? c.usage ?? {}, cached = u.prompt ? u.cached / u.prompt : null;
  const feed = h("div", { class: "feed", id: "feed" }, ...(live.events.length ? live.events : []).map((e) =>
    h("div", { class: `ev ${e.k}${e.error ? " err" : ""}` }, h("span", { class: "ic", text: ICON[e.k] ?? "·" }), h("span", { class: "nm", text: e.name ?? e.k }), h("span", { class: "tx", text: e.text }))));
  if (!live.events.length) feed.append(h("div", { class: "ev" }, h("span"), h("span", { class: "nm", text: "…" }), h("span", { class: "tx muted", text: live.phase === "setting up" ? "setting up the task container" : "waiting for the agent's first step" })));
  fill($("live"), 
    h("label", { class: "auto" }, h("input", { type: "checkbox", checked: autoScroll || undefined, onchange: (e) => (autoScroll = e.target.checked) }), "follow"),
    h("h2", { text: "Now" }),
    h("div", { class: "kv" }, h("b", { text: c.task }), h("span", { text: `variant ${c.variant}` }), h("span", { text: `trial ${c.trial}` }), h("span", { class: "muted", id: "elapsed", "data-started": c.started })),
    h("div", { class: "steps" }, ...order.map((s, i) => h("span", { class: i < at ? "done" : i === at ? "now" : "", text: s }))),
    h("div", { class: "tiles" },
      tile("model requests", u.requests ?? 0), tile("tokens sent", fmtNum(u.prompt)), tile("from cache", pct(cached)), tile("tokens received", fmtNum(u.completion)),
      tile("step", live.step ?? "–")),
    u.perRequest?.length > 1 ? h("div", {}, h("div", { class: "muted small", text: "prompt size per request" }), spark(u.perRequest)) : null,
    feed,
    live.stderr ? h("details", {}, h("summary", { class: "muted small", text: "agent messages (stderr)" }), h("pre", { text: live.stderr })) : null);
  renderElapsed();
  if (autoScroll) { const f = $("feed"); f.scrollTop = f.scrollHeight; }
}
const tile = (l, v) => h("div", { class: "tile" }, h("div", { class: "v", text: v }), h("div", { class: "l", text: l }));
function renderElapsed() { const e = $("elapsed"); if (e?.dataset.started) e.textContent = `running for ${fmtDur((Date.now() - Date.parse(e.dataset.started)) / 1000)}`; }

function renderVariants() {
  const base = ov.variants[0];
  fill($("variants"), h("h2", { text: "Variants" }), h("div", { class: "scroll" }, h("table", {},
    h("tr", {}, ...["variant", "passed", "95% interval", `vs ${base}`, "timeouts", "tokens sent", "per solved", "time"].map((t, i) => h("th", { class: i >= 4 ? "num" : "", text: t }))),
    ...ov.summary.map((s) => h("tr", {},
      h("td", { class: "mono", text: s.variant }),
      h("td", {}, s.runs ? h("div", { class: "rate" }, h("div", { class: "track" }, h("div", { class: "fill", style: `width:${(s.rate * 100).toFixed(0)}%` }), h("div", { class: "ci", style: `left:${(s.ci.lo * 100).toFixed(0)}%;width:${((s.ci.hi - s.ci.lo) * 100).toFixed(0)}%` })), h("span", { text: `${s.passed}/${s.runs}` })) : "–"),
      h("td", { class: "muted", text: s.runs ? `${pct(s.ci.lo)}–${pct(s.ci.hi)}` : "" }),
      h("td", {}, s.vsBaseline ? h("span", {}, h("span", { class: "win", text: `+${s.vsBaseline.wins}` }), " ", h("span", { class: "loss", text: `−${s.vsBaseline.losses}` }), h("span", { class: "muted", text: ` of ${s.vsBaseline.pairs}` })) : h("span", { class: "muted", text: "baseline" })),
      h("td", { class: "num", text: s.timeouts || "" }), h("td", { class: "num", text: fmtNum(s.tokensMedian) }), h("td", { class: "num", text: fmtNum(s.tokensPerSolved) }), h("td", { class: "num", text: s.secondsMedian ? fmtDur(s.secondsMedian) : "–" }))))),
    h("div", { class: "muted small", text: `With ${ov.tasks.length} tasks one task is ${Math.round(100 / Math.max(1, ov.tasks.length))} points: intervals this wide mean "not decided yet". Repeat a difference before believing it.` }));
}

function renderGrid() {
  const latest = new Map(); for (const r of ov.results) latest.set(`${r.task}|${r.variant}`, r);
  fill($("grid"), h("h2", { text: "Tasks" }), h("div", { class: "scroll" }, h("table", {},
    h("tr", {}, h("th", { text: "task" }), ...ov.variants.map((v) => h("th", { text: v }))),
    ...ov.tasks.map((t) => h("tr", {}, h("td", { class: "mono", text: t }), ...ov.variants.map((v) => {
      const r = latest.get(`${t}|${v}`), now = ov.current && ov.current.task === t && ov.current.variant === v;
      const kind = now ? "running" : r ? outcome(r) : "pending";
      return h("td", {}, h("span", { class: `cell ${kind}`, title: r ? `${fmtDur(r.seconds)} · ${fmtNum(r.tokensIn)} tokens sent${r.exception ? ` · ${r.exception}` : ""}` : "", text: kind === "pending" ? "·" : kind,
        onclick: r ? () => openRun(r) : now ? () => document.getElementById("live").scrollIntoView({ behavior: "smooth" }) : undefined }));
    }))))));
}

function renderHistory() {
  const rs = [...ov.results].reverse().slice(0, 60);
  fill($("history"), h("h2", { text: `Finished runs (${ov.results.length})` }), rs.length ? h("div", { class: "scroll" }, h("table", { class: "hist" },
    h("tr", {}, ...["when", "task", "variant", "result", "time", "tokens sent", "cached", "received"].map((t, i) => h("th", { class: i >= 4 ? "num" : "", text: t }))),
    ...rs.map((r) => h("tr", { onclick: () => openRun(r) },
      h("td", { class: "muted", text: new Date(r.at).toLocaleString() }), h("td", { class: "mono", text: r.task }), h("td", { class: "mono", text: r.variant }),
      h("td", {}, h("span", { class: `cell ${outcome(r)}`, text: outcome(r) })), h("td", { class: "num", text: fmtDur(r.seconds) }),
      h("td", { class: "num", text: fmtNum(r.tokensIn) }), h("td", { class: "num", text: fmtNum(r.tokensCached) }), h("td", { class: "num", text: fmtNum(r.tokensOut) }))))) : h("div", { class: "empty", text: "No finished runs yet." }));
}

async function openRun(r) {
  const d = $("drawer"); d.classList.remove("hidden");
  fill(d, h("button", { class: "close", onclick: () => d.classList.add("hidden"), text: "Close" }), h("h2", { text: `${r.task} · ${r.variant} · trial ${r.trial}` }), h("div", { class: "empty", text: "loading…" }));
  const j = await fetch(`/api/job/${encodeURIComponent(r.job)}`).then((x) => x.json()).catch(() => null);
  if (!j) return;
  fill(d, 
    h("button", { class: "close", onclick: () => d.classList.add("hidden"), text: "Close" }),
    h("h2", { text: `${r.task} · ${r.variant} · trial ${r.trial}` }),
    h("div", { class: "kv" }, h("span", {}, h("span", { class: `cell ${outcome(r)}`, text: outcome(r) })), h("span", { text: fmtDur(r.seconds) }), h("span", { text: `${fmtNum(r.tokensIn)} sent · ${fmtNum(r.tokensCached)} cached · ${fmtNum(r.tokensOut)} received` }), h("span", { class: "muted mono small", text: r.job })),
    j.exception ? h("div", {}, h("h2", { text: "Harbor" }), h("pre", { text: `${j.exception.type}: ${j.exception.message}` })) : null,
    j.final ? h("div", {}, h("h2", { text: "The agent's final answer" }), h("pre", { text: `${j.final.finished ? "finished" : "stopped"}${j.final.stopped ? ` (${j.final.stopped})` : ""} after ${j.final.steps ?? "?"} steps\n\n${j.final.text ?? ""}` })) : null,
    j.tests ? h("div", {}, h("h2", { text: "The task's tests" }), h("pre", { text: j.tests })) : null,
    h("h2", { text: `What the agent did (${j.events.length} events)` }),
    h("div", { class: "feed", style: "max-height:none" }, ...j.events.map((e) => h("div", { class: `ev ${e.k}${e.error ? " err" : ""}` }, h("span", { class: "ic", text: ICON[e.k] ?? "·" }), h("span", { class: "nm", text: e.name ?? e.k }), h("span", { class: "tx", text: e.text })))),
    j.stderr ? h("details", {}, h("summary", { class: "muted small", text: "agent messages (stderr)" }), h("pre", { text: j.stderr })) : null);
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("drawer").classList.add("hidden"); });
start();
