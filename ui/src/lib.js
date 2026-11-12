// Shared helpers: formatting, the live stream, the controls, and small stores. Everything from a run (task text, agent output) is untrusted:
// React renders it as text; nothing here builds HTML from it.
import { useEffect, useRef, useState } from "react";

export const fmtDur = (s) => {
  if (s === null || s === undefined || !Number.isFinite(s)) return "–";
  s = Math.max(0, Math.round(s));
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, "0")}m` : s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
};
export const fmtNum = (n) => (n === null || n === undefined || !Number.isFinite(n) ? "–" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n)));
export const fmtInt = (n) => (n === null || n === undefined ? "–" : Number(n).toLocaleString("en-US"));
export const pct = (x) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : Math.round(x * 100) + "%");
export const ago = (iso) => { if (!iso) return ""; const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleDateString(); };
export const since = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 1000 : null);
export const span = (x) => (x?.start ? ((x.end ? Date.parse(x.end) : Date.now()) - Date.parse(x.start)) / 1000 : null);

export const runKey = (r) => `${r.task}|${r.variant}|${r.trial}`;
export function outcome(r) { return r.reward >= 1 ? "pass" : r.exception === "AgentTimeoutError" ? "timeout" : r.exception ? "error" : "fail"; }
export const OUTCOME = {
  pass: { icon: "✓", label: "passed" }, fail: { icon: "✕", label: "failed" }, timeout: { icon: "⏱", label: "timed out" }, error: { icon: "!", label: "error" },
  running: { icon: "●", label: "running" }, pending: { icon: "·", label: "waiting" },
};

/** Variant colours: fixed order of the categorical palette, by the variant's place in the campaign (never by rank). */
export const variantColor = (variants, v) => `var(--series-${(Math.max(0, variants.indexOf(v)) % 8) + 1})`;

export const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } },
};

/** A clock that ticks every second, for elapsed times. */
export function useNow(ms = 1000) {
  const [now, set] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => set(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

/**
 * The live stream of one campaign: overview (when it changed), runner state, and the running job with its conversation, merged by item index
 * (an item that grows, like thinking, comes again with a higher seq and replaces the old copy).
 */
export function useStream(campaign) {
  const [s, set] = useState({ overview: null, state: null, live: null, conn: "connecting", error: null });
  useEffect(() => {
    if (campaign === undefined) return;
    const es = new EventSource(`/api/stream${campaign ? `?campaign=${encodeURIComponent(campaign)}` : ""}`);
    set((p) => ({ ...p, overview: null, live: null, conn: "connecting" }));
    es.onopen = () => set((p) => ({ ...p, conn: "live" }));
    es.onerror = () => set((p) => ({ ...p, conn: "reconnecting" }));
    es.onmessage = (m) => {
      let d; try { d = JSON.parse(m.data); } catch { return; }
      set((p) => {
        if (d.error) return { ...p, error: d.error };
        let live = d.reset ? null : p.live;
        if (d.live) {
          const items = live && live.job === d.live.job ? live.items.slice() : [];
          for (const it of d.live.items) items[it.i] = it;
          if (typeof d.live.count === "number" && items.length > d.live.count) items.length = d.live.count;   // a trajectory that started over is shorter
          live = { ...d.live, items };
        }
        return { overview: d.overview ?? p.overview, state: d.state ?? p.state, live, conn: "live", error: null };
      });
    };
    return () => es.close();
  }, [campaign]);
  return s;
}

export class AuthError extends Error {}

/** Send a control action. Throws AuthError when the studio wants its token. */
export async function control(action, extra = {}) {
  const r = await fetch("/api/control", { method: "POST", headers: { "content-type": "application/json", "x-studio-token": store.get("studio-token", "") }, body: JSON.stringify({ action, ...extra }) });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) throw new AuthError(d.error ?? "token needed");
  if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
  return d;
}

/** Keep a scroll container pinned to the bottom while `follow` is on; scrolling up turns it off. */
export function useFollow(dep) {
  const ref = useRef(null), [follow, setFollow] = useState(true), auto = useRef(false);
  useEffect(() => { const el = ref.current; if (follow && el) { auto.current = true; el.scrollTop = el.scrollHeight; } }, [dep, follow]);
  const onScroll = () => {
    const el = ref.current; if (!el) return;
    if (auto.current) { auto.current = false; return; }
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (follow !== atBottom) setFollow(atBottom);
  };
  return { ref, follow, setFollow, onScroll };
}
