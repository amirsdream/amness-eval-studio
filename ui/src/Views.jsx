// What is tested, with which version, for what purpose, how and where: the campaign list, the builds, the campaign form (new, or a copy with
// changes), the campaign's setup, and each run's recorded setup.
import { Fragment, useEffect, useState } from "react";
import { ago, fmtNum, pct, variantColor } from "./lib.js";

const REPO_URL = "https://github.com/amirsdream/Amness";
const GUARDS = ["coverage", "toolcache", "nudge", "loop", "compact", "readdelta", "stuck", "wrapup", "condense", "schedule", "ledger", "stagnation", "review", "redact", "pin", "anchor", "audit"];
const OPTIONS = [
  ["endpoint", "the model server's base URL (custom and ollama models)"], ["thinking_budget", "most thinking tokens per request (llama.cpp)"], ["off", "guards switched off, comma separated"],
  ["tool_choice", "auto or required"], ["max_steps", "most model turns"], ["max_time", "seconds (default: the task's limit minus a margin)"], ["request", "JSON of extra request fields"],
  ["effort", "reasoning effort"], ["context_window", "the model's window in tokens"], ["max_tokens", "token cap for the run"], ["api", "auto, responses or chat"], ["verify", "a command that must pass before finishing"],
  ["plugin", "plugin files on the studio's machine"], ["runtime", "cache (default) or off"], ["package", "a .tgz path (prefer a build)"],
];
const short = (sha) => (sha ? sha.slice(0, 8) : "");
const useJson = (url, every = 0, dep = null) => {
  const [d, set] = useState(null);
  useEffect(() => { let stop = false; const get = () => fetch(url).then((r) => r.json()).then((j) => !stop && set(j)).catch(() => {}); get(); const t = every ? setInterval(get, every) : null; return () => { stop = true; if (t) clearInterval(t); }; }, [url, every, dep]);
  return d;
};

export const BuildChip = ({ b }) => (!b ? <span className="muted">no build recorded</span> : b.missing ? <span className="bchip bad" title="not in the studio">{b.id} (missing)</span> : b.package ? <span className="bchip" title={b.package}>package file</span>
  : <span className="bchip" title={`${b.id}${b.commit ? `\ncommit ${b.commit}` : ""}${b.note ? `\n${b.note}` : ""}`}>v{b.version}{b.commit ? <span className="muted"> · {short(b.commit)}</span> : null}{noteOf(b) ? <span className="muted"> · {noteOf(b)}</span> : null}</span>);
/** A build's note without a repeat of its version ("v0.7.2 release tarball" on v0.7.2 reads "release tarball"). */
const noteOf = (b) => (b.note ?? "").replace(new RegExp(`^v?${String(b.version).replace(/\./g, "\\.")}\\s*`), "");

/** Every campaign: why it runs, which version, which model where, how far, how well. */
export function CampaignsView({ open, edit }) {
  const list = useJson("/api/campaigns", 5000);
  if (!list) return <main><div className="card skeleton">Loading…</div></main>;
  return (
    <main>
      <section className="card">
        <div className="card-head"><h2>Campaigns <span className="muted small normal">what is tested, with which version, for what purpose, and where</span></h2><button className="primary" onClick={() => edit({})}>＋ New campaign</button></div>
        <div className="clist">{list.map((c) => c.error ? <div key={c.name} className="banner bad">{c.name}: {c.error}</div> : (
          <div key={c.name} className="crow">
            <div className="crow-main">
              <div className="crow-title"><button className="link big" onClick={() => open(c.name)}>{c.name}</button>{c.running && <span className="pill run">● running</span>}{c.active && !c.running ? <span className="pill idle">{c.active}</span> : null}</div>
              {c.purpose ? <div className="purpose">{c.purpose}</div> : <div className="muted small">No purpose written down: duplicate it and say why it runs.</div>}
              {c.about && <div className="muted small">{c.about}</div>}
              <div className="kv small"><span>build <BuildChip b={c.build} /></span><span>model <b className="mono">{c.model}</b></span><span>{c.tasks} tasks × {c.variants} variants × {c.trials}</span>{c.where?.server?.model && <span>server <b>{c.where.server.model}</b></span>}{c.where?.host && <span>on <b>{c.where.host}</b></span>}</div>
            </div>
            <div className="crow-side">
              <div className="cprog"><i style={{ width: pct(c.total ? c.done / c.total : 0) }} /></div>
              <div className="small"><b>{c.done}</b>/{c.total} runs · {pct(c.done ? c.passed / c.done : null)} passed</div>
              <div className="muted small">{c.lastAt ? `last ${ago(c.lastAt)}` : "not run yet"}</div>
              <div className="row-actions"><button onClick={() => open(c.name)}>Open</button><button onClick={() => edit({ from: c.name })} title="A new campaign with this one's settings, to change the version or anything else">Duplicate…</button></div>
            </div>
          </div>
        ))}</div>
      </section>
    </main>
  );
}

/** The builds in the studio and the versions on npm and git that can be added. */
export function BuildsView({ st, call, edit }) {
  const [tick, setTick] = useState(0), builds = useJson("/api/builds", 0, tick + (st?.building?.busy ? 0 : 1)), npm = useJson("/api/npm");
  const [git, setGit] = useState(""), [note, setNote] = useState(""), [open, setOpen] = useState(null), [err, setErr] = useState(null);
  const b = st?.building;
  useEffect(() => { if (b && !b.busy) setTick((t) => t + 1); }, [b?.busy, b?.last]);
  const have = new Set((builds ?? []).map((x) => x.version + (x.source?.kind === "npm" ? ":npm" : "")));
  const add = async (spec) => { setErr(null); try { await call("build-add", { spec, note }); } catch (e) { setErr(e.message); } };
  return (
    <main>
      <section className="card">
        <h2>Builds in the studio <span className="muted small normal">a build never changes once added; every result names the build it ran</span></h2>
        {!builds ? <div className="empty">Loading…</div> : !builds.length ? <div className="empty">No builds yet: add a version below.</div> : (
          <div className="scroll"><table className="builds">
            <thead><tr><th>Version</th><th>From</th><th>Commit</th><th>Added</th><th className="num">Runs</th><th className="num">Passed</th><th>Used by</th><th /></tr></thead>
            <tbody>{builds.map((x) => (
              <Fragment key={x.id}>
                <tr className={open === x.id ? "open" : ""} onClick={() => setOpen(open === x.id ? null : x.id)}>
                  <td><b>v{x.version}</b>{x.note ? <div className="muted small">{x.note}</div> : null}</td>
                  <td className="small">{x.source?.kind === "npm" ? "npm" : x.source?.kind === "git" ? <>git <span className="mono">{x.source.ref}</span></> : <span title={x.source?.path}>file</span>}</td>
                  <td className="mono small">{x.commit ? <a href={`${REPO_URL}/commit/${x.commit}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{short(x.commit)}</a> : <span className="muted">–</span>}</td>
                  <td className="muted small">{ago(x.addedAt)}</td><td className="num">{x.runs}</td><td className="num">{x.runs ? pct(x.passed / x.runs) : "–"}</td>
                  <td className="small">{x.usedBy.map((u) => u.campaign).join(", ") || <span className="muted">none yet</span>}</td>
                  <td><button onClick={(e) => { e.stopPropagation(); edit({ build: x.id }); }}>New campaign…</button></td>
                </tr>
                {open === x.id && <tr className="detail"><td colSpan={8}>
                  <div className="bdetail">
                    <div><div className="muted small">id</div><div className="mono small">{x.id}</div><div className="muted small">sha256</div><div className="mono small">{x.sha256}</div></div>
                    <div className="grow"><div className="muted small">What this version has (its changelog)</div>{x.features?.length ? <ul className="feat">{x.features.map((f, i) => <li key={i}>{f}</li>)}</ul> : <div className="muted small">No changelog found for this version.</div>}</div>
                    <div><div className="muted small">Campaigns</div>{x.usedBy.length ? x.usedBy.map((u) => <div key={u.campaign} className="small"><b>{u.campaign}</b>: {u.passed}/{u.runs} passed{u.purpose ? <div className="muted">{u.purpose}</div> : null}</div>) : <div className="muted small">not used yet</div>}</div>
                  </div>
                </td></tr>}
              </Fragment>
            ))}</tbody>
          </table></div>
        )}
      </section>
      <section className="card">
        <h2>Add a build</h2>
        {b?.busy && <div className="banner"><i className="spin" /> Adding {b.spec}: {b.log.at(-1) ?? "starting"}</div>}
        {b?.error && !b.busy && <div className="banner bad">The last build failed: {b.error}</div>}
        {err && <div className="banner bad">{err}</div>}
        <div className="addrow"><label className="small muted">Note (optional) <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="for example: dev, fixes from the eval" /></label></div>
        <div className="cols">
          <div>
            <h3>Published on npm</h3>
            {!npm ? <div className="empty">Asking npm…</div> : npm.error ? <div className="muted">{npm.error}</div> : (
              <div className="npmlist">{npm.versions.slice(0, 30).map((v) => {
                const tag = Object.entries(npm.tags).find(([, x]) => x === v.version)?.[0], in_ = have.has(v.version + ":npm");
                return <div key={v.version} className="npmrow"><b>v{v.version}</b>{tag && <span className="tag">{tag}</span>}<span className="muted small">{v.published ? ago(v.published) : ""}</span><span className="spacer" />{in_ ? <span className="muted small">in the studio</span> : <button disabled={b?.busy} onClick={() => add(v.version)}>Add</button>}</div>;
              })}</div>
            )}
          </div>
          <div>
            <h3>From git</h3>
            <p className="muted small">A branch, a tag or a commit of <a href={REPO_URL} target="_blank" rel="noreferrer">the Amness repository</a>: the studio checks it out, builds and packs it. Use it for code that is not released yet.</p>
            <div className="addrow"><input value={git} onChange={(e) => setGit(e.target.value)} placeholder="main, v0.7.2 or a commit" /><button disabled={!git.trim() || b?.busy} onClick={() => add(`git:${git.trim()}`)}>Build and add</button></div>
            <p className="muted small">On the studio's machine you can also add a packed file: <code>node bin/studio.mjs build add path/to/amness.tgz</code>.</p>
          </div>
        </div>
      </section>
    </main>
  );
}

/** Option rows (`--ak name=value`) with suggestions. */
function OptionRows({ value, onChange }) {
  const rows = Object.entries(value ?? {});
  const set = (i, k, v) => { const r = rows.slice(); r[i] = [k, v]; onChange(Object.fromEntries(r)); };
  return (
    <div className="opts">
      {rows.map(([k, v], i) => (
        <div key={i} className="optrow">
          <input list="opt-names" value={k} onChange={(e) => set(i, e.target.value, v)} placeholder="option" />
          {k === "off" ? <GuardPick value={String(v)} onChange={(x) => set(i, k, x)} /> : k === "tool_choice" ? <select value={v} onChange={(e) => set(i, k, e.target.value)}><option>auto</option><option>required</option></select> : <input value={v} onChange={(e) => set(i, k, e.target.value)} placeholder={OPTIONS.find(([n]) => n === k)?.[1] ?? "value"} />}
          <button className="icon" onClick={() => onChange(Object.fromEntries(rows.filter((_, j) => j !== i)))} aria-label="Remove option">✕</button>
        </div>
      ))}
      <button className="link" onClick={() => onChange({ ...Object.fromEntries(rows), "": "" })}>＋ option</button>
    </div>
  );
}
function GuardPick({ value, onChange }) {
  const on = new Set(value.split(",").map((x) => x.trim()).filter(Boolean));
  return <div className="guards">{GUARDS.map((g) => <label key={g} className={on.has(g) ? "on" : ""}><input type="checkbox" checked={on.has(g)} onChange={(e) => { const s = new Set(on); e.target.checked ? s.add(g) : s.delete(g); onChange([...s].join(",")); }} />{g}</label>)}</div>;
}

const parseArgs = (args = []) => { const o = {}; for (let i = 0; i < args.length; i++) if ((args[i] === "--ak" || args[i] === "--agent-kwarg") && args[i + 1]) { const s = String(args[++i]), k = s.indexOf("="); o[s.slice(0, k)] = s.slice(k + 1); } return o; };

/** New campaign, or a copy of one with changes (another version, other options). Writes campaigns/<name>.json on the studio. */
export function CampaignForm({ init, close, call, created }) {
  const builds = useJson("/api/builds"), subsets = useJson("/api/subsets"), source = useJson(init.from ? `/api/campaign-file/${encodeURIComponent(init.from)}` : "/api/subsets");
  const [f, setF] = useState(null), [err, setErr] = useState(null), [busy, setBusy] = useState(false);
  useEffect(() => {
    if (f || (init.from && !source?.plan)) return;
    const p = init.from ? source.plan : null, opts = parseArgs(p?.args);
    if (!init.from) delete opts.package;
    setF({
      name: init.from ? `${init.from}-2` : "", purpose: p?.purpose ?? "", about: p?.about ?? "", model: p?.model ?? "custom/qwen-vllm", subset: p?.subset ?? "mini", trials: p?.trials ?? 1,
      build: init.build ?? p?.build ?? "", options: p ? opts : { endpoint: "", thinking_budget: "4096" },
      variants: p ? Object.entries(p.variants).map(([name, v]) => Array.isArray(v) ? { name, options: parseArgs(v), build: "", note: "" } : { name, options: parseArgs(v.args), build: v.build ?? "", note: v.note ?? "" }) : [{ name: "full", options: {}, build: "", note: "" }],
      start: false, from: init.from ?? null,
    });
  }, [source, init]);
  useEffect(() => { if (f && !f.build && builds?.length && !init.from) setF((x) => ({ ...x, build: builds[0].id })); }, [builds]);
  if (!f) return <div className="drawer-wrap center"><div className="dialog">Loading…</div></div>;
  const up = (k, v) => setF({ ...f, [k]: v }), upV = (i, k, v) => setF({ ...f, variants: f.variants.map((x, j) => (j === i ? { ...x, [k]: v } : x)) });
  const runs = (subsets?.find((s) => s.name === f.subset)?.tasks.length ?? 0) * f.variants.length * (Number(f.trials) || 1);
  const save = async () => {
    setErr(null); setBusy(true);
    try {
      const clean = (o) => Object.fromEntries(Object.entries(o).filter(([k, v]) => k && v !== ""));
      const r = await call("campaign-create", { campaign: { ...f, options: clean(f.options), variants: f.variants.map((v) => ({ ...v, options: clean(v.options) })) }, start: f.start });
      created(r.created);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const buildOpts = (empty) => [<option key="" value="">{empty}</option>, ...(builds ?? []).map((b) => <option key={b.id} value={b.id}>v{b.version}{b.note ? ` · ${b.note}` : ""}{b.commit ? ` · ${short(b.commit)}` : ""}</option>)];
  return (
    <div className="drawer-wrap" onClick={(e) => e.target === e.currentTarget && close()}>
      <aside className="drawer form" role="dialog" aria-label="Campaign">
        <div className="drawer-head"><div><div className="live-title"><span className="task">{f.from ? `Copy of ${f.from}` : "New campaign"}</span></div><div className="muted small">Saved as campaigns/{f.name || "…"}.json on the studio</div></div><div className="drawer-actions"><button onClick={close}>✕</button></div></div>
        <datalist id="opt-names">{OPTIONS.map(([n, d]) => <option key={n} value={n}>{d}</option>)}</datalist>
        <div className="fgrid">
          <label>Name<input value={f.name} onChange={(e) => up("name", e.target.value)} placeholder="streams-v3" /></label>
          <label>Model<input value={f.model} onChange={(e) => up("model", e.target.value)} placeholder="custom/qwen-vllm" /></label>
          <label className="wide">Purpose: the question this campaign answers<textarea rows={2} value={f.purpose} onChange={(e) => up("purpose", e.target.value)} placeholder="Does 0.7.2's read fix raise the pass rate on tb2-mini, with the same model and settings as streams?" /></label>
          <label className="wide">About: what it compares, in a sentence<input value={f.about} onChange={(e) => up("about", e.target.value)} /></label>
          <label>Version (build)<select value={f.build} onChange={(e) => up("build", e.target.value)}>{buildOpts("none: the package option")}</select></label>
          <label>Tasks<select value={f.subset} onChange={(e) => up("subset", e.target.value)}>{(subsets ?? []).map((s) => <option key={s.name} value={s.name}>{s.name} ({s.tasks.length} tasks)</option>)}</select></label>
          <label>Trials<input type="number" min={1} max={20} value={f.trials} onChange={(e) => up("trials", e.target.value)} /></label>
        </div>
        <h3>Options for every variant</h3>
        <OptionRows value={f.options} onChange={(o) => up("options", o)} />
        <h3>Variants <span className="muted small normal">the first is the baseline the others are compared with</span></h3>
        <div className="vlist">{f.variants.map((v, i) => (
          <div key={i} className="vcard">
            <div className="vhead"><span className="dotc" style={{ background: variantColor(f.variants.map((x) => x.name), v.name) }} /><input className="vname" value={v.name} onChange={(e) => upV(i, "name", e.target.value)} placeholder="name" />
              <select value={v.build} onChange={(e) => upV(i, "build", e.target.value)} title="This variant's version">{buildOpts("same version as the campaign")}</select>
              <input className="grow" value={v.note} onChange={(e) => upV(i, "note", e.target.value)} placeholder="note (optional)" />
              {f.variants.length > 1 && <button className="icon" onClick={() => up("variants", f.variants.filter((_, j) => j !== i))} aria-label="Remove variant">✕</button>}</div>
            <OptionRows value={v.options} onChange={(o) => upV(i, "options", o)} />
          </div>
        ))}</div>
        <div className="addrow">
          <button onClick={() => up("variants", [...f.variants, { name: `v${f.variants.length + 1}`, options: {}, build: "", note: "" }])}>＋ Variant</button>
          <select value="" onChange={(e) => e.target.value && up("variants", [...f.variants, { name: `no-${e.target.value}`, options: { off: e.target.value }, build: "", note: `${e.target.value} switched off` }])}><option value="">＋ One guard off…</option>{GUARDS.map((g) => <option key={g}>{g}</option>)}</select>
          <select value="" onChange={(e) => { const b = builds?.find((x) => x.id === e.target.value); if (b) up("variants", [...f.variants, { name: `v${b.version}`, options: {}, build: b.id, note: `version ${b.version}` }]); }}><option value="">＋ Another version…</option>{(builds ?? []).map((b) => <option key={b.id} value={b.id}>v{b.version}{b.note ? ` · ${b.note}` : ""}</option>)}</select>
        </div>
        <div className="formfoot">
          <span className="muted">{runs} runs</span>
          <label className="toggle"><input type="checkbox" checked={f.start} onChange={(e) => up("start", e.target.checked)} /> Start it now (the campaign running now must be paused first)</label>
          <span className="spacer" />
          {err && <span className="banner bad inline">{err}</span>}
          <button onClick={close}>Cancel</button><button className="primary" disabled={busy || !f.name} onClick={save}>{busy ? "Saving…" : "Create campaign"}</button>
        </div>
      </aside>
    </div>
  );
}

const Kv = ({ o }) => { const e = Object.entries(o ?? {}); return e.length ? <div className="kvchips">{e.map(([k, v]) => <span key={k} className="kvchip"><span className="muted">{k}</span> {typeof v === "object" ? JSON.stringify(v) : String(v)}</span>)}</div> : <span className="muted small">none</span>; };

/** How the campaign runs: purpose, version, model server, machine, shared options, and what each variant changes. */
export function SetupCard({ s, variants, edit, name }) {
  const [open, setOpen] = useState(true);
  if (!s) return null;
  const srv = s.where?.server;
  return (
    <section className="card">
      <div className="card-head"><h2>Setup <span className="muted small normal">what is tested, with which version, how and where{s.recorded ? ` · recorded with ${s.recorded} runs` : ""}</span></h2><button onClick={() => edit({ from: name })}>Duplicate with changes…</button><button className="icon" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "▾" : "▸"}</button></div>
      {open && <>
        <div className="sgrid">
          <div className="sbox"><div className="l">Version</div><BuildChip b={s.build} />{s.build?.features?.length ? <details><summary className="small">{s.build.features.length} changes in this version</summary><ul className="feat">{s.build.features.map((x, i) => <li key={i}>{x}</li>)}</ul></details> : null}</div>
          <div className="sbox"><div className="l">Model</div><div className="mono">{s.model}</div>{srv?.kind === "llama.cpp" ? <div className="small muted">{srv.model} · context {fmtNum(srv.context)} · {srv.slots} slot{srv.slots > 1 ? "s" : ""} · llama.cpp {srv.build}</div> : srv?.models ? <div className="small muted">server offers {srv.models.join(", ")}</div> : null}{srv?.sampling && <div className="small muted">sampling {Object.entries(srv.sampling).map(([k, v]) => `${k} ${v}`).join(" · ")}</div>}</div>
          <div className="sbox"><div className="l">Where</div><div>{s.where?.host ?? s.where?.studio}{s.where?.cpus ? <span className="muted small"> · {s.where.cpus} cores · {s.where.memoryGb} GB</span> : null}</div>{s.where?.endpoint && <div className="small muted mono">{s.where.endpoint}</div>}{s.where?.harbor && <div className="small muted">harbor {s.where.harbor}</div>}</div>
          <div className="sbox"><div className="l">Tasks</div><div>{s.dataset} · {s.subset} · {s.trials} trial{s.trials > 1 ? "s" : ""}</div><div className="small muted">agent {s.agent}</div></div>
        </div>
        <div className="l2">Options for every variant</div><Kv o={s.shared} />
        <div className="scroll"><table className="vtable">
          <thead><tr><th>Variant</th><th>Version</th><th>Changes from {s.variants[0]?.name}</th><th>Note</th></tr></thead>
          <tbody>{s.variants.map((v, i) => (
            <tr key={v.name}><td><span className="dotc" style={{ background: variantColor(variants, v.name) }} /> <b>{v.name}</b></td><td><BuildChip b={v.build} /></td>
              <td>{i === 0 ? <span className="muted">baseline</span> : v.changes.length ? v.changes.map((c) => <span key={c.option} className="kvchip"><span className="muted">{c.option}</span> {c.from === null ? <b>{c.to}</b> : <>{c.from} → <b>{c.to ?? "(removed)"}</b></>}</span>) : <span className="muted">same as the baseline</span>}</td>
              <td className="muted small">{v.note}</td></tr>
          ))}</tbody>
        </table></div>
      </>}
    </section>
  );
}

/** One run's recorded setup: the exact build, command, server and machine, and the agent's own report of its settings. */
export function RunSetup({ setup }) {
  if (!setup) return <div className="empty">This run was recorded before the studio kept setups (studio 0.3).</div>;
  const e = setup.effective;
  return (
    <div className="rsetup">
      <div className="sgrid">
        <div className="sbox"><div className="l">Version</div><BuildChip b={setup.build} />{e?.version && <div className="small muted">the agent says {e.version}</div>}</div>
        <div className="sbox"><div className="l">Model server</div><div className="mono small">{setup.server?.endpoint ?? "–"}</div>{setup.server?.model && <div className="small muted">{setup.server.model} · context {fmtNum(setup.server.context)}{setup.server.sampling ? ` · temperature ${setup.server.sampling.temperature}` : ""}</div>}</div>
        <div className="sbox"><div className="l">Where</div><div>{setup.where?.host}</div><div className="small muted">harbor {setup.where?.harbor}</div></div>
        <div className="sbox"><div className="l">Task image</div><div className="mono small">{setup.image?.name ?? "built by Harbor"}</div>{setup.image?.digest && <div className="mono small muted" title={setup.image.digest}>{setup.image.digest.split("@")[1]?.slice(0, 19)}…</div>}</div>
      </div>
      <div className="l2">Agent options</div><Kv o={setup.options} />
      <div className="l2">What the agent says was in effect</div>
      {e ? (
        <div className="eff">
          <Kv o={{ model: e.model, "context window": e.contextWindow, "max steps": e.maxSteps, "max time": e.maxTime ? `${e.maxTime} s` : "none", "tool choice": e.toolChoice, "thinking budget": e.thinkingBudget ?? "server default", sandbox: e.sandbox, memory: e.memory ? "on" : "off", ...(e.request ? { request: e.request } : {}), ...(e.verify ? { verify: e.verify } : {}) }} />
          <div className="guards ro">{[...(e.guardsOn ?? []).map((g) => [g, true]), ...(e.guardsOff ?? []).map((g) => [g, false])].sort().map(([g, on]) => <span key={g} className={on ? "on" : "off"} title={on ? "on" : "switched off"}>{on ? "✓" : "✕"} {g}</span>)}</div>
          {e.profile?.sources?.length ? <div className="small muted">profile from {e.profile.sources.join(", ")}</div> : null}
        </div>
      ) : <div className="muted small">Not reported: this Amness version does not send its settings (0.7.3 and later do).</div>}
      <div className="l2">Command</div>
      <pre className="out">{(setup.command ?? []).map((a) => (/[\s"'{}]/.test(a) ? `'${a}'` : a)).join(" ")}</pre>
    </div>
  );
}
