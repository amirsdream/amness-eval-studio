// Small charts: the prompt size of each model request (cached and new, stacked), a pass rate with its 95% interval, and the campaign's progress bar.
import { useState } from "react";
import { fmtInt, fmtNum, OUTCOME, pct } from "./lib.js";

/** One bar per model request: the part served from the prompt cache, and the new part. Hover a bar for its numbers. */
export function PromptBars({ requests, window: ctx }) {
  const [hover, setHover] = useState(null);
  if (!requests?.length) return <div className="empty small">No model requests yet.</div>;
  const W = 600, H = 96, top = 6, max = Math.max(...requests.map((r) => r.prompt), 1), n = requests.length;
  const slot = W / Math.max(n, 12), bw = Math.max(2, Math.min(28, slot - 2)), y = (v) => H - (v / max) * (H - top);
  const h = hover !== null ? requests[hover] : null;
  return (
    <div className="pbars">
      <div className="legend small">
        <span><i className="sw" style={{ background: "var(--series-1)" }} /> from cache</span>
        <span><i className="sw" style={{ background: "var(--series-2)" }} /> new</span>
        <span className="muted">largest prompt {fmtNum(max)} tokens{ctx ? ` of ${fmtNum(ctx)}` : ""}</span>
        {h && <span className="tip-inline">request {hover + 1}: {fmtInt(h.prompt)} sent · {fmtInt(h.cached)} cached ({pct(h.prompt ? h.cached / h.prompt : null)}) · {fmtInt(h.completion)} received</span>}
      </div>
      <svg viewBox={`0 0 ${W} ${H + 1}`} preserveAspectRatio="none" className="pbars-svg" role="img" aria-label={`Prompt size of ${n} model requests, up to ${max} tokens`} onMouseLeave={() => setHover(null)}>
        <line x1="0" x2={W} y1={top} y2={top} className="grid" />
        <line x1="0" x2={W} y1={H} y2={H} className="axis" />
        {requests.map((r, i) => {
          const x = i * slot + (slot - bw) / 2, cached = Math.min(r.cached, r.prompt), yc = y(cached), yp = y(r.prompt);
          return (
            <g key={i} onMouseEnter={() => setHover(i)} className={hover === i ? "hot" : ""}>
              <rect x={i * slot} y={0} width={slot} height={H} fill="transparent" />
              {cached > 0 && <rect x={x} y={yc} width={bw} height={H - yc} fill="var(--series-1)" rx="1.5" />}
              {r.prompt > cached && <rect x={x} y={yp} width={bw} height={Math.max(1, yc - yp - (cached > 0 ? 2 : 0))} fill="var(--series-2)" rx="1.5" />}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Pass rate as a bar, the 95% interval as a whisker, and the count as text. */
export function RateBar({ s }) {
  if (!s.runs) return <span className="muted">no runs yet</span>;
  return (
    <span className="rate" title={`${s.passed} of ${s.runs} passed; 95% interval ${pct(s.ci.lo)} to ${pct(s.ci.hi)}`}>
      <span className="track"><span className="fill" style={{ width: pct(s.rate) }} /><span className="ci" style={{ left: pct(s.ci.lo), width: `${Math.max(0.5, (s.ci.hi - s.ci.lo) * 100)}%` }} /></span>
      <b>{pct(s.rate)}</b><span className="muted">{s.passed}/{s.runs}</span><span className="muted small">{pct(s.ci.lo)}–{pct(s.ci.hi)}</span>
    </span>
  );
}

/** The whole campaign as one bar: a segment per run, coloured by outcome, in run order. */
export function ProgressStrip({ runs, byKey, currentKey, onPick }) {
  return (
    <div className="strip" role="img" aria-label="Every run of the campaign, in order">
      {runs.map((r) => {
        const k = `${r.task}|${r.variant}|${r.trial}`, res = byKey.get(k), o = res ? res.o : k === currentKey ? "running" : "pending";
        return <button key={k} className={`seg ${o}`} title={`${r.task} · ${r.variant} · trial ${r.trial}: ${OUTCOME[o].label}`} onClick={() => res && onPick(res.r)} tabIndex={res ? 0 : -1} />;
      })}
    </div>
  );
}
