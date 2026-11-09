// Small statistics for small samples: medians, a Wilson interval for a pass rate, and paired comparisons between variants on the same tasks.

export const median = (xs) => { const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };

/** 95% Wilson score interval for k passes out of n. Honest at n = 8, unlike the normal approximation. */
export function wilson(k, n, z = 1.96) {
  if (!n) return { lo: 0, hi: 0 };
  const p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d) };
}

/** Per variant: runs, passes, interval, timeouts, medians; and, against `baseline`, the tasks it won and lost (same task and trial in both). */
export function summarize(rows, variants, baseline = variants[0]) {
  const passed = (r) => r.reward >= 1;
  const base = new Map(rows.filter((r) => r.variant === baseline).map((r) => [`${r.task}|${r.trial}`, passed(r)]));
  return variants.map((v) => {
    const x = rows.filter((r) => r.variant === v), k = x.filter(passed).length;
    let wins = 0, losses = 0, pairs = 0;
    if (v !== baseline) for (const r of x) { const b = base.get(`${r.task}|${r.trial}`); if (b === undefined) continue; pairs++; if (passed(r) && !b) wins++; if (!passed(r) && b) losses++; }
    const solved = x.filter(passed), tokens = x.map((r) => r.tokensIn ?? NaN);
    return {
      variant: v, runs: x.length, passed: k, rate: x.length ? k / x.length : null, ci: wilson(k, x.length),
      timeouts: x.filter((r) => r.exception === "AgentTimeoutError").length, errors: x.filter((r) => r.exception && r.exception !== "AgentTimeoutError").length,
      tokensMedian: median(tokens), secondsMedian: median(x.map((r) => r.seconds)),
      tokensPerSolved: solved.length ? Math.round(tokens.filter(Number.isFinite).reduce((a, b) => a + b, 0) / solved.length) : null,
      vsBaseline: v === baseline ? null : { pairs, wins, losses },
    };
  });
}
