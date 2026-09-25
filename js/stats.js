/* stats.js — the numbers a latency run is actually judged on.

   The previous version reported a running mean and called it the result. The
   mean is the worst single summary of a latency series: queueing delay is
   one-sided — it can only ever add to the true path time, never subtract — so
   one retransmit drags the mean somewhere no packet ever was, and it stays
   dragged for the rest of the session.

   What matters instead:
     min    the best observation, and the closest estimate of the actual path
            delay, because the only thing that could have made it smaller is
            an even emptier queue
     p50    what a typical request sees
     p95    what the unlucky one in twenty sees — the number a user notices
     jitter mean absolute difference between consecutive samples (the same
            definition RFC 3550 uses for RTP), which is what breaks a call
     loss   the metric that was missing entirely before, and the one that
            decides whether a link is usable at all

   Loss was not merely unreported: the old "Sent" counter incremented only on
   success, so a target that failed every single request displayed 0 sent, 0%
   of anything, and an empty chart that looked like it had simply not started.

   Samples are held in a bounded ring. Exact quantiles over a few thousand
   values cost nothing and avoid the estimator error of a streaming digest, and
   the bound is what stops an overnight run from growing without limit — the
   old array was unbounded and was re-summed on every single sample. */

const CAP = 5000;

export class Series {
  constructor(label) {
    this.label = label;
    this.rtts = [];        // warm successes only — what the statistics describe
    this.all = [];         // every settled probe, for the chart and the log
    this.sent = 0;
    this.lost = 0;
    this.cold = null;      // the handshake sample, kept but held apart
    this.lastDetail = false;
  }

  push(sample) {
    this.sent++;
    this.all.push(sample);
    if (this.all.length > CAP) this.all.shift();

    if (!sample.ok) { this.lost++; return; }
    this.lastDetail = sample.detail;
    if (sample.cold) { this.cold = sample; return; }   // excluded, on purpose
    this.rtts.push(sample.rtt);
    if (this.rtts.length > CAP) this.rtts.shift();
  }

  get count() { return this.rtts.length; }
  get loss() { return this.sent ? (this.lost / this.sent) * 100 : 0; }

  /** Quantile by nearest-rank on a sorted copy. */
  q(p) {
    const n = this.rtts.length;
    if (!n) return null;
    const s = [...this.rtts].sort((a, b) => a - b);
    const i = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
    return s[i];
  }

  get min() { return this.rtts.length ? Math.min(...this.rtts) : null; }
  get max() { return this.rtts.length ? Math.max(...this.rtts) : null; }
  get mean() {
    const n = this.rtts.length;
    return n ? this.rtts.reduce((a, b) => a + b, 0) / n : null;
  }

  /** Mean absolute successive difference — RFC 3550's interarrival jitter. */
  get jitter() {
    const r = this.rtts, n = r.length;
    if (n < 2) return null;
    let sum = 0;
    for (let i = 1; i < n; i++) sum += Math.abs(r[i] - r[i - 1]);
    return sum / (n - 1);
  }

  /** Standard deviation — the spread p95 alone does not convey. */
  get stdev() {
    const n = this.rtts.length;
    if (n < 2) return null;
    const m = this.mean;
    return Math.sqrt(this.rtts.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  }

  snapshot() {
    return {
      label: this.label, sent: this.sent, lost: this.lost, loss: this.loss,
      count: this.count, min: this.min, p50: this.q(50), p95: this.q(95),
      max: this.max, mean: this.mean, jitter: this.jitter, stdev: this.stdev,
      detail: this.lastDetail, cold: this.cold ? this.cold.rtt : null,
    };
  }

  reset() {
    this.rtts = []; this.all = []; this.sent = 0; this.lost = 0; this.cold = null;
  }
}

/** Fold several targets into one fleet-wide reading. min is the best of the
    bests; loss is pooled over requests, not averaged over targets, so ten
    silent probes against one host are not cancelled out by ten good ones
    against another. */
export function combine(seriesList) {
  const live = seriesList.filter((s) => s.count > 0);
  const sent = seriesList.reduce((a, s) => a + s.sent, 0);
  const lost = seriesList.reduce((a, s) => a + s.lost, 0);
  const pool = seriesList.flatMap((s) => s.rtts);
  const sorted = [...pool].sort((a, b) => a - b);
  const q = (p) => (sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
    : null);
  const jitters = live.map((s) => s.jitter).filter((v) => v != null);
  return {
    targets: seriesList.length,
    sent, lost,
    loss: sent ? (lost / sent) * 100 : 0,
    mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    min: sorted.length ? sorted[0] : null,
    p50: q(50), p95: q(95),
    max: sorted.length ? sorted[sorted.length - 1] : null,
    jitter: jitters.length ? jitters.reduce((a, b) => a + b, 0) / jitters.length : null,
  };
}

/** Verdict bands, in the units people actually feel. Deliberately about the
    experience, not a letter grade: 40 ms with 5% loss is a worse line than
    180 ms clean, and the wording has to be able to say that. */
export function verdict(s) {
  if (!s.sent) return { key: 'idle', text: 'No data yet.' };
  if (s.loss >= 100) return { key: 'bad', text: 'No response at all — target unreachable from this browser.' };
  if (s.loss >= 5) return { key: 'bad', text: 'Loss above 5% — this link will stutter on calls and stall on transfers.' };
  if (s.loss > 0) return { key: 'warn', text: 'Some requests never came back — intermittent loss.' };
  if (s.p95 == null) return { key: 'idle', text: 'No data yet.' };
  if (s.p95 > 600) return { key: 'bad', text: 'Very high latency — interactive use will feel broken.' };
  if (s.p95 > 250) return { key: 'warn', text: 'High latency — noticeable lag on anything interactive.' };
  if (s.jitter != null && s.jitter > 60) return { key: 'warn', text: 'Latency is steady on average but swings a lot — poor for real-time audio and video.' };
  if (s.p95 > 120) return { key: 'ok', text: 'Usable. Fine for browsing, adequate for calls.' };
  return { key: 'good', text: 'Low and steady. Nothing here would hold a connection back.' };
}

/* ---- report helpers --------------------------------------------------------
   The report prints the distribution plus the handful of samples at each end,
   not the whole log. These two functions are what "peaks and lows" and
   "unanswered probes" mean, computed from the same series the screen uses so
   the two can never disagree. */

/**
 * Peaks and lows.
 *
 * "The n slowest samples overall" sounds right and is nearly useless: on any
 * run with one distant host, all n come from that host and the table just says
 * "the slow one is slow" n times. What a reader is looking for is a *spike* —
 * a sample far above what that same target normally does — so peaks are ranked
 * by how far each sample sits above its own target's median, and each row says
 * by how much.
 *
 * Lows are one row per target: its best sample, which is the closest thing the
 * run has to that path's floor.
 */
export function extremes(seriesList, n = 5) {
  const peaks = [];
  const lows = [];
  for (const s of seriesList) {
    const p50 = s.q(50);
    let best = null;
    for (const x of s.all) {
      if (!x.ok || x.cold || x.rtt == null) continue;
      if (p50 != null) peaks.push({ target: s.label, rtt: x.rtt, at: x.at, over: x.rtt - p50, kind: 'high' });
      if (!best || x.rtt < best.rtt) best = { target: s.label, rtt: x.rtt, at: x.at, over: null, kind: 'low' };
    }
    if (best) lows.push(best);
  }
  peaks.sort((a, b) => b.over - a.over);
  // A peak that is not actually above the median is not a peak; a perfectly
  // flat target contributes none rather than padding the table with noise.
  const realPeaks = peaks.filter((p) => p.over > 0).slice(0, n);
  lows.sort((a, b) => a.rtt - b.rtt);
  return [...realPeaks, ...lows];
}

/** One row per target that lost anything, with when it started and stopped. */
export function lossEvents(seriesList) {
  const out = [];
  for (const s of seriesList) {
    const bad = s.all.filter((x) => !x.ok);
    if (!bad.length) continue;
    const kinds = [...new Set(bad.map((x) => (x.timedOut ? 'timeout' : 'unreachable')))];
    out.push({
      target: s.label,
      count: bad.length,
      kinds,
      firstAt: bad[0].at,
      lastAt: bad[bad.length - 1].at,
    });
  }
  return out.sort((a, b) => b.count - a.count);
}
