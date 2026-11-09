// The agent's conversation: the task, each step with its thinking, messages and tool calls (with their full output), edits, and the harness's guard actions.
import { useMemo, useState } from "react";
import { fmtNum, pct, store, useFollow } from "./lib.js";

/** Plain text with ``` fences as code blocks, `inline code` and **bold**: React elements only. */
export function Markdown({ text }) {
  const parts = String(text ?? "").split(/```[\w-]*\n?/);
  return (
    <div className="md">
      {parts.map((p, i) => (i % 2 ? <pre key={i} className="code">{p.replace(/\n$/, "")}</pre> : <Inline key={i} text={p} />))}
    </div>
  );
}
function Inline({ text }) {
  const bits = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/);
  return <span className="prose">{bits.map((b, i) => (b.startsWith("`") && b.endsWith("`") && b.length > 2 ? <code key={i}>{b.slice(1, -1)}</code> : b.startsWith("**") && b.endsWith("**") && b.length > 4 ? <strong key={i}>{b.slice(2, -2)}</strong> : b))}</span>;
}

const TOOL_ICON = { sh: "$", bash: "$", read_file: "📄", list_files: "🗂", grep: "🔎", glob: "🔎", edit_file: "✎", write_file: "✎", apply_patch: "✎", finish: "■", web_fetch: "🌐", web_search: "🌐", memory_save: "🧠", todo: "☑" };

/** The one line that says what a tool call does: the command, the path, the pattern. */
function headline(it) {
  const a = it.args;
  if (!a || typeof a !== "object") return String(a ?? "");
  return a.cmd ?? a.command ?? a.path ?? a.pattern ?? a.query ?? a.url ?? a.file ?? Object.values(a).find((v) => typeof v === "string") ?? JSON.stringify(a);
}

function Clamp({ text, lines = 12, className = "" }) {
  const [open, setOpen] = useState(false), all = String(text ?? ""), rows = all.split("\n"), long = rows.length > lines || all.length > 2400;
  const shown = open || !long ? all : rows.slice(0, lines).join("\n").slice(0, 2400);
  return (
    <div className={`clamp ${className}`}>
      <pre>{shown}{!open && long ? "\n…" : ""}</pre>
      {long && <button className="link" onClick={() => setOpen(!open)}>{open ? "Show less" : `Show all ${rows.length} lines`}</button>}
    </div>
  );
}

function Tool({ it, showOutput }) {
  const [open, setOpen] = useState(null), expanded = open ?? showOutput;
  const exit = /^exit=(\d+)/.exec(it.result ?? "")?.[1];
  const status = it.status === "skipped" ? "skipped" : it.status !== "done" ? (it.status === "running" ? "running" : "planned") : it.error ? "error" : "ok";
  const head = String(headline(it));
  const isShell = it.name === "sh" || it.name === "bash";
  return (
    <div className={`tool ${status}`}>
      <button className="tool-head" onClick={() => setOpen(!expanded)} aria-expanded={expanded}>
        <span className="tool-ic" aria-hidden>{TOOL_ICON[it.name] ?? "▸"}</span>
        <span className="tool-name">{it.name}</span>
        <span className="tool-arg">{isShell ? head.split("\n")[0] : head}</span>
        <span className={`tool-st ${status}`}>{status === "running" ? <><i className="spin" /> running</> : status === "planned" ? "queued" : status === "skipped" ? "not run" : status === "error" ? `✕ ${exit ? `exit ${exit}` : "error"}` : `✓${exit !== undefined ? ` exit ${exit}` : ""}`}</span>
        <span className="chev" aria-hidden>{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="tool-body">
          {isShell && head.includes("\n") ? <pre className="cmd">{head}</pre> : null}
          {typeof it.args === "object" && Object.keys(it.args ?? {}).length > 1 || !isShell ? <details className="args"><summary>Arguments</summary><pre>{typeof it.args === "string" ? it.args : JSON.stringify(it.args, null, 2)}</pre></details> : null}
          {it.result !== null && it.result !== undefined ? <Clamp text={it.result} className={it.error ? "bad" : ""} /> : <div className="muted small">{status === "running" ? "waiting for output…" : "not run yet"}</div>}
        </div>
      )}
    </div>
  );
}

function Diff({ diff }) {
  const [open, setOpen] = useState(false), rows = String(diff ?? "").split("\n");
  if (!diff) return null;
  const shown = open ? rows : rows.slice(0, 18);
  return (
    <div className="diff">
      <pre>{shown.map((l, i) => <span key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : ""}>{l}{"\n"}</span>)}</pre>
      {rows.length > 18 && <button className="link" onClick={() => setOpen(!open)}>{open ? "Show less" : `Show all ${rows.length} lines`}</button>}
    </div>
  );
}

function Item({ it, opts }) {
  switch (it.t) {
    case "system": return <details className="sys"><summary>System prompt <span className="muted">· {fmtNum(it.text.length)} characters</span></summary><pre>{it.text}</pre></details>;
    case "user": return <div className="msg user"><div className="who">Task</div><Markdown text={it.text} /></div>;
    case "step": {
      const u = it.usage;
      return (
        <div className="step" id={`step-${it.step}`}>
          <span className="step-n">Step {it.step + 1}{it.max ? <span className="muted"> / {it.max}</span> : null}</span>
          {u ? <span className="step-u">prompt {fmtNum(u.prompt)} · {pct(u.prompt ? u.cached / u.prompt : null)} cached · out {fmtNum(u.completion)}{u.reasoning ? ` · thinking ${fmtNum(u.reasoning)}` : ""}</span> : <span className="step-u"><i className="spin" /> asking the model…</span>}
        </div>
      );
    }
    case "thinking":
      if (!opts.thinking && !it.live) return null;
      return (
        <details className={`think ${it.live ? "live" : ""}`} open={it.live || opts.thinking}>
          <summary>{it.live ? <><i className="spin" /> Thinking…</> : "Thinking"} <span className="muted">· {fmtNum(it.text.length)} characters</span></summary>
          <pre>{it.text}{it.live && <span className="caret" />}</pre>
        </details>
      );
    case "text": return <div className={`msg agent ${it.live ? "live" : ""}`}><div className="who">Agent</div><Markdown text={it.text} />{it.live && <span className="caret" />}</div>;
    case "tool": return <Tool it={it} showOutput={opts.output} />;
    case "edit": return (
      <div className="edit">
        <div className="edit-head"><span aria-hidden>✎</span> <span className="mono">{it.path}</span>{it.created && <span className="tag">new file</span>}<span className="add">+{it.added}</span><span className="del">−{it.removed}</span></div>
        <Diff diff={it.diff} />
      </div>
    );
    case "guard": return <div className="guard"><span className="guard-name">⚑ {it.name}</span> <span>{it.text}</span></div>;
    case "steer": return <div className="guard steer"><span className="guard-name">↪ steer</span> <span>{it.text}</span></div>;
    case "audit": return <div className="audit">Audit: changed {it.changed.length ? it.changed.map((f) => <code key={f}>{f}</code>) : "nothing"}{it.notes.length ? ` · ${it.notes.join(" · ")}` : ""}</div>;
    case "finish": return <div className="msg finish"><div className="who">Finish</div><Markdown text={it.text} /></div>;
    case "end": return (
      <div className={`end ${it.finished ? "ok" : "stop"}`}>
        <b>{it.finished ? "■ Finished" : `■ Stopped${it.stopped ? `: ${it.stopped}` : ""}`}</b>
        {it.usage ? <span className="muted"> · sent {fmtNum(it.usage.prompt)} · cached {fmtNum(it.usage.cached)} · received {fmtNum(it.usage.completion)}{it.cost ? ` · $${it.cost.toFixed(3)}` : ""}</span> : null}
      </div>
    );
    default: return null;
  }
}

/** The conversation with its toolbar: show thinking, expand tool output, follow the latest. */
export function Chat({ items, live = false, height }) {
  const [thinking, setThinking] = useState(store.get("chat-thinking", false)), [output, setOutput] = useState(store.get("chat-output", false)), [q, setQ] = useState("");
  const list = useMemo(() => (items ?? []).filter(Boolean), [items]);
  const last = list.length ? `${list.length}:${list[list.length - 1].seq}` : "0";
  const { ref, follow, setFollow, onScroll } = useFollow(last);
  const shown = q ? list.filter((it) => JSON.stringify([it.text, it.args, it.result, it.path, it.name]).toLowerCase().includes(q.toLowerCase())) : list;
  const tools = list.filter((x) => x.t === "tool"), steps = list.filter((x) => x.t === "step").length, guards = list.filter((x) => x.t === "guard").length;
  return (
    <div className="chat">
      <div className="chat-bar">
        <span className="muted small">{steps} steps · {tools.length} tool calls{tools.some((t) => t.error) ? ` (${tools.filter((t) => t.error).length} failed)` : ""}{guards ? ` · ${guards} guard actions` : ""}</span>
        <span className="spacer" />
        <input className="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the conversation" />
        <label className="toggle"><input type="checkbox" checked={thinking} onChange={(e) => { setThinking(e.target.checked); store.set("chat-thinking", e.target.checked); }} /> Thinking</label>
        <label className="toggle"><input type="checkbox" checked={output} onChange={(e) => { setOutput(e.target.checked); store.set("chat-output", e.target.checked); }} /> Tool output</label>
        {live && <label className="toggle"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow</label>}
      </div>
      <div className="chat-scroll" ref={ref} onScroll={live ? onScroll : undefined} style={height ? { maxHeight: height } : undefined}>
        {shown.length ? shown.map((it) => <Item key={it.i} it={it} opts={{ thinking, output }} />) : <div className="empty">{q ? "Nothing matches." : "No conversation yet: the agent starts after the container is ready."}</div>}
      </div>
      {live && !follow && <button className="jump" onClick={() => setFollow(true)}>↓ Latest</button>}
    </div>
  );
}
