// Amness Evaluation Studio: one page per campaign. Live run on top (phases, tokens, the conversation as it streams), results below
// (variants with intervals, the task × variant grid, every finished run), and the runner's controls in the header.
import { useEffect, useMemo, useRef, useState } from "react";
import { AuthError, ago, control, fmtDur, fmtInt, fmtNum, outcome, OUTCOME, pct, runKey, since, span, store, useNow, useStream, variantColor } from "./lib.js";
import { Chat } from "./Chat.jsx";
import { PromptBars, ProgressStrip, RateBar } from "./Charts.jsx";

const PHASES = [["environment", "Container"], ["install", "Install"], ["agent", "Agent"], ["tests", "Tests"]];
const PHASE_AT = { starting: 0, "setting up": 0, installing: 1, agent: 2, testing: 3, done: 4 };

function useHash() {
  const [h, set] = useState(location.hash);
  useEffect(() => { const f = () => set(location.hash); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  return [h, (v) => { if (v) location.hash = v; else history.replaceState(null, "", location.pathname + location.search); set(v ? "#" + v.replace(/^#/, "") : ""); }];
}

export function App() {
  const [campaigns, setCampaigns] = useState([]);
  const [campaign, setCampaign] = useState(undefined);
  const [theme, setTheme] = useState(store.get("theme", "auto"));
  const [toasts, setToasts] = useState([]);
  const [askToken, setAskToken] = useState(null);
  const [hash, setHash] = useHash();
  const s = useStream(campaign);
  const ov = s.overview, st = s.state;

  useEffect(() => { if (theme === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme; store.set("theme", theme); }, [theme]);
  useEffect(() => {
    fetch("/api/campaigns").then((r) => r.json()).then((list) => {
      setCampaigns(list);
      const want = new URLSearchParams(location.search).get("campaign");
      setCampaign(want && list.some((c) => c.name === want) ? want : (list.find((c) => c.running) ?? list[0])?.name ?? "");
    }).catch(() => setCampaign(""));
  }, []);
  useEffect(() => { if (ov) document.title = `${ov.done}/${ov.total} · ${ov.name} · Evaluation Studio`; }, [ov?.done, ov?.total, ov?.name]);

  // A toast for each run that finishes while the page is open.
  const seen = useRef(null);
  useEffect(() => {
    if (!ov) return;
    const keys = new Set(ov.results.map((r) => r.job));
    if (seen.current && seen.current.name === ov.name) for (const r of ov.results) if (!seen.current.keys.has(r.job)) toast(`${OUTCOME[outcome(r)].icon} ${r.task} · ${r.variant}: ${OUTCOME[outcome(r)].label} in ${fmtDur(r.seconds)}`, outcome(r));
    seen.current = { name: ov.name, keys };
  }, [ov?.results]);

  function toast(text, kind = "info") { const id = Math.random(); setToasts((t) => [...t.slice(-3), { id, text, kind }]); setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000); }
  async function act(action, extra = {}) {
    try { await control(action, { campaign: ov?.name, ...extra }); }
    catch (e) { if (e instanceof AuthError) setAskToken({ action, extra }); else toast(e.message, "error"); }
  }
  const pick = (c) => { setCampaign(c); history.replaceState(null, "", `?campaign=${encodeURIComponent(c)}${location.hash}`); };
  const openRun = (r) => setHash(`run=${encodeURIComponent(r.job)}`);
  const openJob = /^#run=(.+)$/.exec(hash)?.[1];

  return (
    <>
      <header className="top">
        <div className="brand"><span className="mark" /> Evaluation Studio</div>
        <select value={campaign ?? ""} onChange={(e) => pick(e.target.value)} aria-label="Campaign">
          {campaigns.map((c) => <option key={c.name} value={c.name}>{c.name}{c.total ? ` (${c.done}/${c.total})` : ""}</option>)}
        </select>
        <Controls st={st} ov={ov} act={act} />
        <span className="spacer" />
        <span className={`conn ${s.conn}`} title="Live connection to the studio">{s.conn === "live" ? "live" : s.conn}</span>
        <button className="icon" onClick={() => setTheme(theme === "auto" ? "dark" : theme === "dark" ? "light" : "auto")} title={`Theme: ${theme}`} aria-label="Switch theme">{theme === "light" ? "☀" : theme === "dark" ? "☾" : "◐"}</button>
      </header>
      {s.error && <div className="banner bad">{s.error}</div>}
      {campaign === "" && <div className="banner">No campaigns: add a file to <code>campaigns/</code>.</div>}
      {ov ? (
        <main>
          <Hero ov={ov} st={st} openRun={openRun} act={act} />
          <div className="row">
            <Live live={s.live} ov={ov} st={st} act={act} />
            <aside className="side">
              <Queue ov={ov} />
              <Activity st={st} />
            </aside>
          </div>
          <Scoreboard ov={ov} />
          <Matrix ov={ov} openRun={openRun} />
          <History ov={ov} openRun={openRun} />
        </main>
      ) : campaign ? <main><div className="card skeleton">Connecting…</div></main> : null}
      {openJob && ov && <RunDrawer job={decodeURIComponent(openJob)} ov={ov} live={s.live} close={() => setHash("")} act={act} />}
      {askToken && <TokenDialog close={() => setAskToken(null)} retry={() => { const a = askToken; setAskToken(null); act(a.action, a.extra); }} />}
      <div className="toasts" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}</div>
    </>
  );
}

const STATUS = { running: ["● Running", "run"], pausing: ["◌ Pausing", "warn"], paused: ["❚❚ Paused", "idle"], idle: ["○ Idle", "idle"], done: ["✓ Complete", "ok"], error: ["! Stopped", "bad"] };

function Controls({ st, ov, act }) {
  const [menu, setMenu] = useState(false);
  if (!st) return null;
  const mine = !st.campaign || st.campaign === ov?.name, status = mine ? st.status : "idle", [label, kind] = STATUS[status] ?? STATUS.idle;
  const startOpts = [["Until done", 0], ["For 30 minutes", 30], ["For 1 hour", 60], ["For 2 hours", 120]];
  return (
    <div className="controls">
      <span className={`pill ${kind}`} title={st.message || undefined}>{label}{!mine && st.status === "running" ? ` (${st.campaign})` : ""}{st.until && mine ? ` · until ${new Date(st.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</span>
      {mine && status === "running" && <>
        <button onClick={() => act("pause")} title="Finish the run in progress, then stop">❚❚ Pause</button>
        <button className="danger" onClick={() => confirm("Stop the run in progress now? It is not recorded and runs again on resume.") && act("stop")} title="Interrupt the run in progress">■ Stop now</button>
      </>}
      {mine && status === "pausing" && <>
        <button className="primary" onClick={() => act("resume")}>▶ Keep running</button>
        <button className="danger" onClick={() => act("stop")}>■ Stop now</button>
      </>}
      {(!mine ? st.status !== "running" && st.status !== "pausing" : ["paused", "idle", "error", "done"].includes(status)) && ov?.left > 0 && (
        <div className="split">
          <button className="primary" onClick={() => act("start")}>▶ {status === "idle" ? "Start" : "Resume"}</button>
          <button className="primary caret-btn" onClick={() => setMenu(!menu)} aria-label="Start options" aria-expanded={menu}>▾</button>
          {menu && <div className="menu" onMouseLeave={() => setMenu(false)}>
            {startOpts.map(([l, m]) => <button key={l} onClick={() => { setMenu(false); act("start", { minutes: m }); }}>{l}</button>)}
            <hr /><button onClick={() => { setMenu(false); act("warm"); }}>Warm up the caches only</button>
          </div>}
        </div>
      )}
    </div>
  );
}

function Hero({ ov, st, openRun }) {
  const byKey = useMemo(() => new Map(ov.results.map((r) => [runKey(r), { r, o: outcome(r) }])), [ov.results]);
  const runs = useMemo(() => { const out = []; for (let t = 1; t <= ov.trials; t++) for (const task of ov.tasks) for (const variant of ov.variants) out.push({ task, variant, trial: t }); return out; }, [ov.tasks, ov.variants, ov.trials]);
  const counts = ov.results.reduce((m, r) => { m[outcome(r)]++; return m; }, { pass: 0, fail: 0, timeout: 0, error: 0 });
  const warm = st?.warm, tokens = ov.results.reduce((a, r) => a + (r.tokensIn ?? 0), 0);
  return (
    <section className="card hero">
      <div className="hero-top">
        <div className="hero-name">
          <h1>{ov.name}</h1>
          {ov.about && <p className="muted">{ov.about}</p>}
          <div className="kv small"><span>model <b className="mono">{ov.model}</b></span><span>dataset <b>{ov.dataset}</b></span><span>{ov.tasks.length} tasks × {ov.variants.length} variants × {ov.trials} trial{ov.trials > 1 ? "s" : ""}</span></div>
        </div>
        <div className="hero-stats">
          <Stat v={<>{ov.done}<span className="muted">/{ov.total}</span></>} l="runs done" />
          <Stat v={pct(ov.total ? ov.done / ov.total : 0)} l="complete" />
          <Stat v={ov.left ? fmtDur(ov.etaSeconds) : "–"} l="time left" sub={`≈ ${fmtDur(ov.perRunSeconds)} a run`} />
          <Stat v={pct(ov.done ? counts.pass / ov.done : null)} l="passed overall" sub={`${counts.pass} ✓ · ${counts.fail} ✕${counts.timeout ? ` · ${counts.timeout} ⏱` : ""}${counts.error ? ` · ${counts.error} !` : ""}`} />
          <Stat v={fmtNum(tokens)} l="tokens sent" />
        </div>
      </div>
      <ProgressStrip runs={runs} byKey={byKey} currentKey={ov.current ? runKey(ov.current) : null} onPick={openRun} />
      <div className="strip-legend small muted">
        {["pass", "fail", "timeout", "running", "pending"].map((o) => <span key={o}><i className={`seg ${o}`} /> {OUTCOME[o].label}</span>)}
        {warm?.campaign === ov.name && warm.tasks.length > 0 && <span className="warm" title={warm.tasks.map((t) => `${t.task}: ${t.image ?? "built by Harbor"} ${t.ready ? "✓" : t.pulling ? "(pulling)" : "(not yet)"}`).join("\n")}>{warm.busy ? <i className="spin" /> : "⛁"} {warm.message}</span>}
      </div>
    </section>
  );
}
const Stat = ({ v, l, sub }) => <div className="stat"><div className="v">{v}</div><div className="l">{l}</div>{sub && <div className="sub muted small">{sub}</div>}</div>;

function Phases({ phase, timing, started }) {
  useNow();
  const at = PHASE_AT[phase] ?? 0;
  return (
    <ol className="phases">
      {PHASES.map(([k, l], i) => {
        const d = span(timing?.[k]);
        return <li key={k} className={i < at ? "done" : i === at ? "now" : ""}><span className="dot">{i < at ? "✓" : i + 1}</span><span>{l}</span>{d !== null && <span className="muted small">{fmtDur(d)}</span>}</li>;
      })}
      <li className={at >= 4 ? "done" : ""}><span className="dot">{at >= 4 ? "✓" : "■"}</span><span>Result</span></li>
      <li className="elapsed muted small">{started ? `${fmtDur(since(started))} so far` : ""}</li>
    </ol>
  );
}

function Live({ live, ov, st, act }) {
  const [tab, setTab] = useState("chat");
  const cur = ov.current;
  if (!cur || !live) {
    const status = st?.campaign === ov.name ? st.status : "idle";
    return (
      <section className="card live idle-live">
        <h2>Now</h2>
        <div className="idle-box">
          <div className="big">{status === "done" || !ov.left ? "The campaign is complete." : status === "pausing" ? "Pausing…" : status === "running" ? "Starting the next run…" : "Nothing is running."}</div>
          {st?.message && <div className="muted">{st.message}</div>}
          {ov.left > 0 && !["running", "pausing"].includes(status) && <button className="primary" onClick={() => act("start")}>▶ {ov.done ? "Resume" : "Start"} the campaign</button>}
        </div>
      </section>
    );
  }
  const u = live.usage, lastPrompt = u?.perRequest?.at(-1)?.prompt;
  return (
    <section className="card live">
      <div className="live-head">
        <div>
          <h2>Now</h2>
          <div className="live-title"><span className="task">{cur.task}</span> <span className="chip" style={{ "--c": variantColor(ov.variants, cur.variant) }}>{cur.variant}</span> <span className="muted">trial {cur.trial}</span></div>
        </div>
        <a className="link small" href={`#run=${encodeURIComponent(cur.job)}`}>Open run ↗</a>
      </div>
      <Phases phase={live.phase} timing={live.timing} started={live.startedAt} />
      <div className="tiles">
        <Tile v={live.step !== null ? <>{live.step + 1}{live.maxSteps ? <span className="muted">/{live.maxSteps}</span> : null}</> : "–"} l="step" sub={live.agentPhase ? `now: ${live.agentPhase}` : null} />
        <Tile v={fmtInt(u?.requests ?? 0)} l="model requests" />
        <Tile v={fmtNum(lastPrompt)} l="last prompt" />
        <Tile v={fmtNum(u?.prompt)} l="tokens sent" />
        <Tile v={pct(u?.prompt ? u.cached / u.prompt : null)} l="from cache" />
        <Tile v={fmtNum(u?.completion)} l="received" sub={u?.reasoning ? `${fmtNum(u.reasoning)} thinking` : null} />
      </div>
      <PromptBars requests={u?.perRequest} />
      <div className="tabs" role="tablist">
        {[["chat", `Conversation${live.count ? ` (${live.count})` : ""}`], ["tests", "Tests"], ["stderr", "Agent log"]].map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === "chat" && <Chat items={live.items} live height="620px" />}
      {tab === "tests" && (live.tests ? <pre className="out">{live.tests}</pre> : <div className="empty">The tests run after the agent finishes.</div>)}
      {tab === "stderr" && (live.stderr ? <pre className="out">{live.stderr}</pre> : <div className="empty">Nothing on the agent's error output.</div>)}
    </section>
  );
}
const Tile = ({ v, l, sub }) => <div className="tile"><div className="v">{v}</div><div className="l">{l}</div>{sub && <div className="sub muted small">{sub}</div>}</div>;

function Queue({ ov }) {
  return (
    <section className="card">
      <h2>Up next</h2>
      {ov.upcoming.length ? <ol className="queue">{ov.upcoming.map((r) => <li key={runKey(r)}><span className="dotc" style={{ background: variantColor(ov.variants, r.variant) }} /> <span className="mono">{r.task}</span> <span className="muted">· {r.variant}{ov.trials > 1 ? ` · t${r.trial}` : ""}</span></li>)}</ol> : <div className="empty">Nothing left.</div>}
      {ov.left > ov.upcoming.length + (ov.current ? 1 : 0) ? <div className="muted small">and {ov.left - ov.upcoming.length - (ov.current ? 1 : 0)} more</div> : null}
    </section>
  );
}

function Activity({ st }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [st?.log?.length]);
  return (
    <section className="card">
      <h2>Runner log</h2>
      <div className="log" ref={ref}>{st?.log?.length ? st.log.map((l, i) => <div key={i}><span className="muted">{new Date(l.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span> {l.text}</div>) : <div className="empty">Nothing yet in this session.</div>}</div>
    </section>
  );
}

function Scoreboard({ ov }) {
  const base = ov.variants[0];
  return (
    <section className="card">
      <h2>Variants <span className="muted small normal">compared with <b>{base}</b> on the same task and trial; one task run once cannot show a small difference</span></h2>
      <div className="scroll">
        <table className="score">
          <thead><tr><th>Variant</th><th>Pass rate (95% interval)</th><th className="num" title="Tasks this variant solved and the baseline did not / the other way round">vs {base}</th><th className="num">Timeouts</th><th className="num">Errors</th><th className="num">Median tokens</th><th className="num">Median time</th><th className="num">Tokens per solved task</th></tr></thead>
          <tbody>{ov.summary.map((s) => (
            <tr key={s.variant}>
              <td><span className="dotc" style={{ background: variantColor(ov.variants, s.variant) }} /> <b>{s.variant}</b></td>
              <td><RateBar s={s} /></td>
              <td className="num">{s.vsBaseline ? (s.vsBaseline.pairs ? <><span className="win">+{s.vsBaseline.wins}</span> <span className="loss">−{s.vsBaseline.losses}</span> <span className="muted small">of {s.vsBaseline.pairs}</span></> : "–") : <span className="muted">baseline</span>}</td>
              <td className="num">{s.runs ? s.timeouts : "–"}</td><td className="num">{s.runs ? s.errors : "–"}</td>
              <td className="num">{fmtNum(s.tokensMedian)}</td><td className="num">{fmtDur(s.secondsMedian)}</td><td className="num">{fmtNum(s.tokensPerSolved)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  );
}

function Matrix({ ov, openRun }) {
  const cur = ov.current ? runKey(ov.current) : null;
  const by = useMemo(() => { const m = new Map(); for (const r of ov.results) m.set(runKey(r), r); return m; }, [ov.results]);
  const disagree = (task) => { const os = new Set(); for (const v of ov.variants) for (let t = 1; t <= ov.trials; t++) { const r = by.get(`${task}|${v}|${t}`); if (r) os.add(r.reward >= 1); } return os.size > 1; };
  return (
    <section className="card">
      <h2>Tasks × variants <span className="muted small normal">▲ marks a task where the variants disagree</span></h2>
      <div className="scroll">
        <table className="matrix">
          <thead><tr><th>Task</th>{ov.variants.map((v) => <th key={v}><span className="dotc" style={{ background: variantColor(ov.variants, v) }} /> {v}</th>)}</tr></thead>
          <tbody>{ov.tasks.map((task) => (
            <tr key={task}>
              <td className="mono">{task}{disagree(task) && <span className="flag" title="The variants disagree on this task"> ▲</span>}</td>
              {ov.variants.map((v) => (
                <td key={v}>{Array.from({ length: ov.trials }, (_, i) => {
                  const k = `${task}|${v}|${i + 1}`, r = by.get(k), o = r ? outcome(r) : k === cur ? "running" : "pending";
                  return <button key={k} className={`cell ${o}`} disabled={!r} onClick={() => r && openRun(r)} title={r ? `${OUTCOME[o].label} in ${fmtDur(r.seconds)}, ${fmtNum(r.tokensIn)} tokens` : OUTCOME[o].label}>{OUTCOME[o].icon} {r ? fmtDur(r.seconds) : o === "running" ? "now" : ""}</button>;
                })}</td>
              ))}
            </tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  );
}

function History({ ov, openRun }) {
  const [v, setV] = useState(""), [o, setO] = useState("");
  const rows = ov.results.slice().reverse().filter((r) => (!v || r.variant === v) && (!o || outcome(r) === o));
  return (
    <section className="card">
      <div className="card-head">
        <h2>Finished runs <span className="muted small normal">{ov.results.length}</span></h2>
        <div className="filters">
          <select value={v} onChange={(e) => setV(e.target.value)} aria-label="Filter by variant"><option value="">All variants</option>{ov.variants.map((x) => <option key={x}>{x}</option>)}</select>
          <select value={o} onChange={(e) => setO(e.target.value)} aria-label="Filter by outcome"><option value="">All outcomes</option>{["pass", "fail", "timeout", "error"].map((x) => <option key={x} value={x}>{OUTCOME[x].label}</option>)}</select>
        </div>
      </div>
      <div className="scroll">
        <table className="hist">
          <thead><tr><th>Finished</th><th>Task</th><th>Variant</th><th>Result</th><th className="num">Time</th><th className="num">Sent</th><th className="num">Cached</th><th className="num">Received</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.job} onClick={() => openRun(r)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && openRun(r)}>
              <td className="muted" title={r.at}>{ago(r.at)}</td><td className="mono">{r.task}</td>
              <td><span className="dotc" style={{ background: variantColor(ov.variants, r.variant) }} /> {r.variant}{ov.trials > 1 ? <span className="muted"> t{r.trial}</span> : null}</td>
              <td><span className={`badge ${outcome(r)}`}>{OUTCOME[outcome(r)].icon} {OUTCOME[outcome(r)].label}</span></td>
              <td className="num">{fmtDur(r.seconds)}</td><td className="num">{fmtNum(r.tokensIn)}</td><td className="num">{pct(r.tokensIn ? (r.tokensCached ?? 0) / r.tokensIn : null)}</td><td className="num">{fmtNum(r.tokensOut)}</td>
            </tr>
          ))}</tbody>
        </table>
        {!rows.length && <div className="empty">No finished runs{v || o ? " match" : " yet"}.</div>}
      </div>
    </section>
  );
}

function RunDrawer({ job, ov, live, close, act }) {
  const [d, setD] = useState(null), [tab, setTab] = useState("chat"), [err, setErr] = useState(null);
  const isLive = live?.job === job;
  useEffect(() => {
    if (isLive) return;
    setD(null); setErr(null);
    fetch(`/api/job/${encodeURIComponent(job)}?since=0`).then((r) => r.json()).then(setD).catch((e) => setErr(e.message));
  }, [job, isLive]);
  useEffect(() => { const f = (e) => e.key === "Escape" && close(); addEventListener("keydown", f); return () => removeEventListener("keydown", f); }, []);
  const v = isLive ? live : d, r = ov.results.find((x) => x.job === job), o = r ? outcome(r) : isLive ? "running" : null;
  return (
    <div className="drawer-wrap" onClick={(e) => e.target === e.currentTarget && close()}>
      <aside className="drawer" role="dialog" aria-label="Run details">
        <div className="drawer-head">
          <div>
            <div className="live-title"><span className="task">{r?.task ?? v?.task ?? job}</span>{r && <span className="chip" style={{ "--c": variantColor(ov.variants, r.variant) }}>{r.variant}</span>}{r && <span className="muted">trial {r.trial}</span>}{o && <span className={`badge ${o}`}>{OUTCOME[o].icon} {OUTCOME[o].label}</span>}</div>
            <div className="muted small mono">{job}</div>
          </div>
          <div className="drawer-actions">
            {r && <button onClick={() => confirm(`Run ${r.task} · ${r.variant} · trial ${r.trial} again? Its result is set aside (kept in results.removed.jsonl).`) && act("rerun", { key: runKey(r) })}>↻ Run again</button>}
            <button onClick={close} aria-label="Close">✕</button>
          </div>
        </div>
        {err && <div className="banner bad">{err}</div>}
        {!v ? <div className="empty">Loading…</div> : <>
          <Phases phase={v.phase} timing={v.timing} started={null} />
          <div className="tiles">
            <Tile v={r ? fmtDur(r.seconds) : "–"} l="wall time" />
            <Tile v={fmtInt(v.usage?.requests ?? 0)} l="model requests" />
            <Tile v={fmtNum(r?.tokensIn ?? v.usage?.prompt)} l="tokens sent" />
            <Tile v={pct((r?.tokensIn ?? v.usage?.prompt) ? (r?.tokensCached ?? v.usage?.cached ?? 0) / (r?.tokensIn ?? v.usage?.prompt) : null)} l="from cache" />
            <Tile v={fmtNum(r?.tokensOut ?? v.usage?.completion)} l="received" />
            <Tile v={v.reward ?? "–"} l="reward" />
          </div>
          {v.exception && <div className="banner bad"><b>{v.exception.type}</b> {v.exception.message}</div>}
          <PromptBars requests={v.usage?.perRequest} />
          <div className="tabs" role="tablist">
            {[["chat", `Conversation${v.count ? ` (${v.count})` : ""}`], ["tests", "Tests"], ["stderr", "Agent log"]].map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}
          </div>
          {tab === "chat" && <Chat items={v.items} live={isLive} />}
          {tab === "tests" && (v.tests ? <pre className="out">{v.tests}</pre> : <div className="empty">No test output.</div>)}
          {tab === "stderr" && (v.stderr ? <pre className="out">{v.stderr}</pre> : <div className="empty">Nothing on the agent's error output.</div>)}
        </>}
      </aside>
    </div>
  );
}

function TokenDialog({ close, retry }) {
  const [t, setT] = useState(store.get("studio-token", ""));
  return (
    <div className="drawer-wrap center" onClick={(e) => e.target === e.currentTarget && close()}>
      <form className="dialog" onSubmit={(e) => { e.preventDefault(); store.set("studio-token", t.trim()); retry(); }}>
        <h3>Studio token</h3>
        <p className="muted small">The controls of this studio need its token (<code>STUDIO_TOKEN</code> on the server; the installer prints it, and it is in <code>/etc/amness-studio.env</code>). It is kept in this browser only.</p>
        <input type="password" autoFocus value={t} onChange={(e) => setT(e.target.value)} aria-label="Token" />
        <div className="dialog-actions"><button type="button" onClick={close}>Cancel</button><button className="primary" type="submit">Save and retry</button></div>
      </form>
    </div>
  );
}
