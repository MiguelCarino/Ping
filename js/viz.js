/* viz.js — charts without a chart library, per the fleet's Data Viz rules.

   The previous version pulled Chart.js off a CDN to draw one line, then fed
   every target into that single dataset — so four hosts became one sawtooth
   that described none of them. Here each target is its own series, and colour
   is the only thing tying a line to the card above it.

   Colours come out of the CSS custom properties via getComputedStyle, so the
   chart cannot drift away from the tokens the rest of the page uses.

   Timeouts are drawn, not dropped. A gap in the line is the single most
   informative mark on a latency chart and the old one had no way to show it:
   losses never entered the dataset, so a link that failed half its requests
   drew the same clean line as one that answered every time. */

const FONT = "10px 'IBM Plex Mono', ui-monospace, monospace";

function css(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** The per-target line colours. Gold stays the brand/interactive accent, so
    the first series takes it and the rest are spaced around the wheel at a
    lightness that holds up on near-black. The order is the one that passes
    the colour-vision check on adjacent pairs: sky next to violet did not
    (ΔE 5.2 deutan), pink between them does (worst pair 10.3). */
export function seriesColor(i) {
  const fixed = [css('--accent', '#eab308'), '#38bdf8', '#f472b6', '#a78bfa', '#34d399', '#fb923c'];
  return fixed[i % fixed.length];
}

function rgba(hex, a) {
  const m = hex.replace('#', '');
  const v = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const n = parseInt(v, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Inline-SVG micro chart for a target card. `points` may contain nulls for
    lost probes; the path breaks there rather than bridging the gap. */
export function sparkline(points, color, { w = 240, h = 34, pad = 3 } = {}) {
  const vals = points.filter((p) => p != null);
  if (vals.length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"></svg>`;
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const n = points.length;
  const x = (i) => pad + (i / (n - 1)) * (w - pad * 2);
  const y = (v) => pad + (1 - (v - min) / span) * (h - pad * 2);

  let d = '', open = false, drops = '';
  for (let i = 0; i < n; i++) {
    if (points[i] == null) {
      open = false;
      drops += `<line x1="${x(i).toFixed(1)}" y1="${pad}" x2="${x(i).toFixed(1)}" y2="${h - pad}"/>`;
      continue;
    }
    d += (open ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(points[i]).toFixed(1) + ' ';
    open = true;
  }
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">`
    + `<g class="spark-drop" stroke="${css('--err', '#ef4444')}" stroke-width="1" opacity=".55">${drops}</g>`
    + `<path d="${d.trim()}" fill="none" stroke="${color}" stroke-width="1.5"/>`
    + '</svg>';
}

/**
 * Multi-series latency chart.
 * @param canvas  target <canvas>
 * @param series  [{ label, color, points: (number|null)[] }]
 * @param opts    { log: boolean } — log scale when the spread demands it
 */
export function drawChart(canvas, series, { log = false } = {}) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(1, rect.width), H = Math.max(1, rect.height);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const grid = css('--border', '#262626');
  const axis = css('--text-muted', '#666');
  const err = css('--err', '#ef4444');

  const all = series.flatMap((s) => s.points).filter((v) => v != null);
  if (all.length < 2) {
    ctx.fillStyle = axis; ctx.font = FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(canvas.dataset.empty || 'Waiting for the first round trip…', W / 2, H / 2);
    return;
  }

  // Latency is bounded below by physics and unbounded above, so the axis
  // starts at zero only when the data is already near it — otherwise a LAN
  // series pinned to the top of the frame tells you nothing about its shape.
  const lo = Math.min(...all), hi = Math.max(...all);
  const useLog = log && lo > 0 && hi / lo > 25;
  const fwd = useLog ? Math.log10 : (v) => v;
  let yMin = useLog ? fwd(Math.max(lo * 0.8, 0.1)) : (lo < 20 ? 0 : lo * 0.85);
  let yMax = useLog ? fwd(hi * 1.2) : hi * 1.1;
  if (yMax - yMin < 1e-6) yMax = yMin + 1;

  const rows = 4;
  ctx.font = FONT;
  const labels = [];
  let widest = 0;
  for (let r = 0; r <= rows; r++) {
    const t = yMin + ((yMax - yMin) * r) / rows;
    const v = useLog ? 10 ** t : t;
    const text = v >= 100 ? Math.round(v) + '' : v.toFixed(v >= 10 ? 1 : 2);
    labels.push({ t, text });
    widest = Math.max(widest, ctx.measureText(text).width);
  }

  const padL = Math.min(Math.ceil(widest) + 14, Math.max(28, W * 0.4));
  const padR = 10, padT = 10, padB = 16;
  const n = Math.max(...series.map((s) => s.points.length));
  const X = (i) => padL + (n <= 1 ? 0 : (i / (n - 1)) * (W - padL - padR));
  const Y = (v) => padT + (1 - (fwd(v) - yMin) / (yMax - yMin)) * (H - padT - padB);

  ctx.strokeStyle = grid; ctx.fillStyle = axis; ctx.lineWidth = 1;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const { t, text } of labels) {
    const yy = padT + (1 - (t - yMin) / (yMax - yMin)) * (H - padT - padB);
    ctx.globalAlpha = 0.45;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(text, padL - 6, yy);
  }
  ctx.textAlign = 'left';
  ctx.fillText('ms', padL + 2, padT + 4);

  // Loss markers under the lines: one faint vertical rule per lost probe, so a
  // run of them reads as a band and a single one still shows.
  ctx.strokeStyle = err; ctx.globalAlpha = 0.28; ctx.lineWidth = 1;
  for (const s of series) {
    for (let i = 0; i < s.points.length; i++) {
      if (s.points[i] != null) continue;
      ctx.beginPath(); ctx.moveTo(X(i), padT); ctx.lineTo(X(i), H - padB); ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  for (const s of series) {
    const pts = s.points;
    // Area only when it is the sole series — stacked translucent fills turn
    // four readable lines into mud.
    if (series.length === 1) {
      const g = ctx.createLinearGradient(0, padT, 0, H - padB);
      g.addColorStop(0, rgba(s.color, 0.22)); g.addColorStop(1, rgba(s.color, 0));
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < pts.length; i++) {
        if (pts[i] == null) continue;
        if (!started) { ctx.moveTo(X(i), H - padB); ctx.lineTo(X(i), Y(pts[i])); started = true; }
        else ctx.lineTo(X(i), Y(pts[i]));
      }
      if (started) {
        const last = pts.map((v, i) => (v == null ? -1 : i)).reduce((a, b) => Math.max(a, b), -1);
        ctx.lineTo(X(last), H - padB); ctx.closePath();
        ctx.fillStyle = g; ctx.fill();
      }
    }

    ctx.strokeStyle = s.color; ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    let open = false;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i] == null) { open = false; continue; }   // the gap IS the finding
      if (!open) { ctx.moveTo(X(i), Y(pts[i])); open = true; }
      else ctx.lineTo(X(i), Y(pts[i]));
    }
    ctx.stroke();

    const li = pts.map((v, i) => (v == null ? -1 : i)).reduce((a, b) => Math.max(a, b), -1);
    if (li >= 0) {
      ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.arc(X(li), Y(pts[li]), 2.4, 0, Math.PI * 2); ctx.fill();
    }
  }
}

/** Stacked phase bar: DNS | TCP | TLS | TTFB | transfer for one sample.
    Only drawn when Timing-Allow-Origin actually gave us the split — the point
    of the component is that it cannot be faked from a single total. */
export function phaseBar(sample) {
  if (!sample || !sample.detail) return '';
  const parts = [
    ['dns', sample.dns, '#38bdf8'],
    ['tcp', Math.max(0, sample.tcp - sample.tls), '#a78bfa'],
    ['tls', sample.tls, '#f472b6'],
    ['ttfb', sample.ttfb, css('--accent', '#eab308')],
    ['xfer', sample.transfer, '#34d399'],
  ].filter(([, v]) => v > 0.05);
  const total = parts.reduce((a, [, v]) => a + v, 0) || 1;
  return '<div class="phasebar" role="img" aria-label="connection phases">'
    + parts.map(([k, v, c]) =>
      `<span class="ph" style="width:${((v / total) * 100).toFixed(2)}%;background:${c}" title="${k} ${v.toFixed(1)} ms"></span>`).join('')
    + '</div>';
}

/* ---- charts for an imported log ---------------------------------------------

   A live run is a few hundred points per target and the chart above draws
   every one. A week of `ping -t` is 600 000, and drawing those would mean
   600 000 path segments per repaint to paint maybe 900 pixel columns. So the
   time chart buckets each series into one column per pixel and draws what a
   column actually holds: its min–max as a faint band and its mean as the line.
   Narrow data falls back to drawing every point, gaps included.

   Every function here returns a `hit(px, py)` for the hover layer, which the
   caller turns into a tooltip — the drawing code never touches the DOM beyond
   its own canvas. */

function setup(canvas) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(1, rect.width), H = Math.max(1, rect.height);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.font = FONT;
  return { ctx, W, H };
}

function emptyMsg(ctx, W, H, text) {
  ctx.fillStyle = css('--text-muted', '#666');
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, W / 2, H / 2);
}

/** Y scale + gridlines + labels. Returns { Y, padL } for a given plot box. */
function yAxis(ctx, { lo, hi, log, zero, unit, integer, padT, H, padB, W, padR }) {
  const useLog = log && lo > 0 && hi / lo > 25;
  const fwd = useLog ? Math.log10 : (v) => v;
  let yMin = useLog ? fwd(Math.max(lo * 0.8, 0.1)) : (zero || lo < 20 ? 0 : lo * 0.85);
  let yMax = useLog ? fwd(hi * 1.2) : hi * 1.1;
  if (integer && !useLog) { yMin = Math.floor(lo) - 1; yMax = Math.ceil(hi) + 1; }
  if (yMax - yMin < 1e-6) yMax = yMin + 1;
  // As many gridlines as fit: four on a normal pane, one on a phone held sideways.
  const rows = Math.max(1, Math.min(4, Math.floor((H - padT - padB) / 26))), labels = [];
  let widest = 0;
  for (let r = 0; r <= rows; r++) {
    const tv = yMin + ((yMax - yMin) * r) / rows;
    const v = useLog ? 10 ** tv : tv;
    const text = integer ? String(Math.round(v)) : (v >= 100 ? Math.round(v) + '' : v.toFixed(v >= 10 ? 1 : 2));
    labels.push({ tv, text });
    widest = Math.max(widest, ctx.measureText(text).width);
  }
  const padL = Math.min(Math.ceil(widest) + 14, Math.max(28, W * 0.4));
  const Y = (v) => padT + (1 - (fwd(v) - yMin) / (yMax - yMin)) * (H - padT - padB);
  ctx.strokeStyle = css('--border', '#262626'); ctx.fillStyle = css('--text-muted', '#666'); ctx.lineWidth = 1;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const { tv, text } of labels) {
    const yy = padT + (1 - (tv - yMin) / (yMax - yMin)) * (H - padT - padB);
    ctx.globalAlpha = 0.45;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(text, padL - 6, yy);
  }
  if (unit) { ctx.textAlign = 'left'; ctx.fillText(unit, padL + 2, padT + 4); }
  return { Y, padL };
}

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400,
  172800, 604800].map((s) => s * 1000);

/** Time ticks at a round step, labelled by the caller's formatter. */
function xAxis(ctx, { x0, x1, X, padL, W, padR, H, fmtX }) {
  const span = Math.max(1, x1 - x0);
  const target = Math.max(2, Math.floor((W - padL - padR) / 90));
  const step = STEPS.find((s) => span / s <= target) || STEPS[STEPS.length - 1];
  ctx.fillStyle = css('--text-muted', '#666'); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.strokeStyle = css('--border', '#262626'); ctx.globalAlpha = 1;
  // Align to the step in local time when the step is a day or less, so ticks
  // land on 10:00 and not 10:00:07.
  const off = new Date(x0).getTimezoneOffset() * 60000;
  let first = Math.ceil((x0 - off) / step) * step + off;
  if (fmtX.utc) first = Math.ceil(x0 / step) * step;
  for (let tv = first; tv <= x1; tv += step) {
    const xx = X(tv);
    if (xx < padL + 12 || xx > W - padR - 12) continue;
    ctx.beginPath(); ctx.moveTo(xx, H - 14); ctx.lineTo(xx, H - 11); ctx.stroke();
    ctx.fillText(fmtX(tv, step), xx, H);
  }
}

/**
 * Time-axis chart for an imported log.
 * @param series [{ label, color, t: number[], v: number[] }] — v is NaN for a
 *               lost probe; t ascending
 * @param opts   { x0, x1, log, unit, integer, loss (draw loss rules), fmtX,
 *                 sel: [a, b] | null, empty }
 */
export function drawTimeChart(canvas, series, opts) {
  if (!canvas) return null;
  const { ctx, W, H } = setup(canvas);
  const { x0, x1 } = opts;
  let lo = Infinity, hi = -Infinity, n = 0;
  for (const s of series) for (let i = 0; i < s.v.length; i++) {
    const v = s.v[i];
    if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; n++; }
  }
  const anyLoss = series.some((s) => s.v.some((v) => v !== v));
  if (!n && !anyLoss) { emptyMsg(ctx, W, H, opts.empty || ''); return null; }
  if (!n) { lo = 0; hi = 1; }

  const padT = 10, padB = 18, padR = 10;
  const { Y, padL } = yAxis(ctx, { lo, hi, log: opts.log, unit: opts.unit, integer: opts.integer, padT, H, padB, W, padR });
  const span = Math.max(1, x1 - x0);
  const pw = W - padL - padR;
  const X = (tv) => padL + ((tv - x0) / span) * pw;
  const cols = Math.max(1, Math.floor(pw));
  xAxis(ctx, { x0, x1, X, padL, W, padR, H, fmtX: opts.fmtX });

  const err = css('--err', '#ef4444');
  const binned = series.map((s) => {
    const mn = new Float64Array(cols).fill(Infinity), mx = new Float64Array(cols).fill(-Infinity);
    const sum = new Float64Array(cols), cnt = new Uint32Array(cols), lost = new Uint32Array(cols);
    for (let i = 0; i < s.t.length; i++) {
      const c = Math.floor(((s.t[i] - x0) / span) * cols);
      if (c < 0 || c >= cols) continue;
      const v = s.v[i];
      if (v !== v) { lost[c]++; continue; }
      if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v;
      sum[c] += v; cnt[c]++;
    }
    return { mn, mx, sum, cnt, lost };
  });

  // Loss first, underneath: a rule per column that lost anything, its strength
  // the share lost, so an outage reads as a solid band while 0.3 % scattered
  // loss over a week stays a haze — with a fixed floor, a column holding one
  // loss in 600 painted as loudly as a dead link and the chart drowned in red.
  if (opts.loss) {
    ctx.strokeStyle = err; ctx.lineWidth = 1;
    for (let c = 0; c < cols; c++) {
      let l = 0, all = 0;
      for (const b of binned) { l += b.lost[c]; all += b.lost[c] + b.cnt[c]; }
      if (!l) continue;
      ctx.globalAlpha = 0.05 + 0.8 * Math.min(1, (l / all) * 2);
      const xx = padL + c + 0.5;
      ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, H - padB); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  const dense = n > cols * 1.5;
  series.forEach((s, si) => {
    const b = binned[si];
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (dense) {
      // min–max band per column
      ctx.strokeStyle = s.color; ctx.globalAlpha = 0.28; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 0; c < cols; c++) {
        if (!b.cnt[c]) continue;
        const xx = padL + c + 0.5;
        ctx.moveTo(xx, Y(b.mx[c])); ctx.lineTo(xx, Math.max(Y(b.mn[c]), Y(b.mx[c]) + 1));
      }
      ctx.stroke();
      ctx.globalAlpha = 1; ctx.lineWidth = 1.6;
      ctx.beginPath();
      let open = false;
      for (let c = 0; c < cols; c++) {
        if (!b.cnt[c]) { if (b.lost[c]) open = false; continue; }
        const xx = padL + c + 0.5, yy = Y(b.sum[c] / b.cnt[c]);
        if (!open) { ctx.moveTo(xx, yy); open = true; } else ctx.lineTo(xx, yy);
      }
      ctx.stroke();
    } else {
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.6;
      ctx.beginPath();
      let open = false, prevY = null;
      for (let i = 0; i < s.t.length; i++) {
        const v = s.v[i];
        if (s.t[i] < x0 || s.t[i] > x1) continue;
        if (v !== v) { open = false; continue; }
        const xx = X(s.t[i]), yy = Y(v);
        if (!open) { ctx.moveTo(xx, yy); open = true; }
        else { if (opts.integer) ctx.lineTo(xx, prevY); ctx.lineTo(xx, yy); }
        prevY = yy;
      }
      ctx.stroke();
      if (n <= cols / 4) {
        ctx.fillStyle = s.color;
        for (let i = 0; i < s.t.length; i++) {
          const v = s.v[i];
          if (v !== v || s.t[i] < x0 || s.t[i] > x1) continue;
          ctx.beginPath(); ctx.arc(X(s.t[i]), Y(v), 2.2, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
  });

  if (opts.sel) {
    const [a, bb] = opts.sel;
    const xa = Math.max(padL, Math.min(X(a), X(bb))), xb = Math.min(W - padR, Math.max(X(a), X(bb)));
    ctx.fillStyle = rgba(css('--accent', '#eab308'), 0.12);
    ctx.fillRect(xa, padT, xb - xa, H - padT - padB);
    ctx.strokeStyle = css('--accent', '#eab308'); ctx.lineWidth = 1;
    ctx.strokeRect(xa + 0.5, padT + 0.5, xb - xa - 1, H - padT - padB - 1);
  }

  const toT = (px) => x0 + ((Math.max(padL, Math.min(W - padR, px)) - padL) / pw) * span;
  return {
    plot: { l: padL, r: W - padR, t: padT, b: H - padB },
    toT, toX: X,
    hit(px) {
      if (px < padL || px > W - padR) return null;
      const c = Math.min(cols - 1, Math.max(0, Math.floor(px - padL)));
      // Widen the hit to a few columns either side: nobody lands on one pixel.
      const rows = series.map((s, si) => {
        const b = binned[si];
        let mn = Infinity, mx = -Infinity, sum = 0, cnt = 0, lost = 0;
        for (let k = Math.max(0, c - 3); k <= Math.min(cols - 1, c + 3); k++) {
          if (b.cnt[k]) { mn = Math.min(mn, b.mn[k]); mx = Math.max(mx, b.mx[k]); sum += b.sum[k]; cnt += b.cnt[k]; }
          lost += b.lost[k];
        }
        return { label: s.label, color: s.color, cnt, lost, mn, mx, mean: cnt ? sum / cnt : null };
      });
      if (!rows.some((r) => r.cnt || r.lost)) return null;
      return { x: padL + c + 0.5, t0: toT(px - 3.5), t1: toT(px + 3.5), rows };
    },
  };
}

/**
 * Distribution: one stepped outline per target over shared bins, as a share
 * of that target's replies, so a target with ten times the samples does not
 * flatten the others. The top bin collects everything above the 99th
 * percentile — one 4-second straggler would otherwise squeeze the whole
 * distribution into the first two bins.
 */
export function drawHistogram(canvas, series, opts = {}) {
  if (!canvas) return null;
  const { ctx, W, H } = setup(canvas);
  // `opts.sorted` is every value of every series, already sorted — passed in
  // by a caller that draws the same data repeatedly.
  let pool = opts.sorted;
  if (!pool) {
    let m = 0;
    for (const s of series) m += s.values.length;
    pool = new Float64Array(m);
    let o = 0;
    for (const s of series) { pool.set(s.values, o); o += s.values.length; }
    pool.sort();
  }
  if (pool.length < 2) { emptyMsg(ctx, W, H, opts.empty || ''); return null; }
  const lo = pool[0];
  let hi = pool[Math.min(pool.length - 1, Math.floor(pool.length * 0.99))];
  const overflow = hi < pool[pool.length - 1];
  if (hi - lo < 1e-6) hi = lo + 1;
  const nb = Math.max(8, Math.min(48, Math.floor((W - 60) / 14)));
  // Two hosts a decade apart (6 ms and 40 ms) on linear bins put the fast one
  // in a single bar. Past a 4x spread the bins are spaced logarithmically, so
  // each target keeps its shape; the edges are labelled either way.
  const logBins = lo > 0 && hi / lo > 4;
  const edge = (i) => (logBins ? lo * (hi / lo) ** (i / nb) : lo + ((hi - lo) * i) / nb);
  const binOf = (v) => (v > hi ? nb
    : Math.max(0, Math.floor(logBins ? (Math.log(v / lo) / Math.log(hi / lo)) * nb : ((v - lo) / (hi - lo)) * nb)));
  const bins = nb + (overflow ? 1 : 0);
  const shares = series.map((s) => {
    const c = new Float64Array(bins);
    for (const v of s.values) c[Math.min(bins - 1, binOf(v))]++;
    const n = s.values.length || 1;
    return c.map((x) => (x / n) * 100);
  });
  let top = 0;
  for (const sh of shares) for (const v of sh) if (v > top) top = v;
  const padT = 10, padB = 18, padR = 10;
  const { Y, padL } = yAxis(ctx, { lo: 0, hi: top, zero: true, unit: '%', padT, H, padB, W, padR });
  const pw = W - padL - padR;
  const X = (i) => padL + (i / bins) * pw;

  ctx.fillStyle = css('--text-muted', '#666'); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  const every = Math.max(1, Math.ceil(bins / Math.max(2, Math.floor(pw / 64))));
  const lab = (v) => (v >= 100 ? String(Math.round(v)) : v.toFixed(v >= 10 ? 0 : 1));
  const last = overflow ? nb - every : nb;          // keep clear of the overflow label
  for (let i = 0; i <= last; i += every) ctx.fillText(lab(edge(i)) + (i === 0 ? ' ms' : ''), X(i) + (i === 0 ? 14 : 0), H);
  if (overflow) { ctx.textAlign = 'right'; ctx.fillText('≥' + lab(hi), W - padR, H); }

  shares.forEach((sh, si) => {
    const s = series[si];
    if (series.length === 1) {
      ctx.fillStyle = rgba(s.color, 0.22);
      for (let i = 0; i < bins; i++) {
        if (!sh[i]) continue;
        ctx.fillRect(X(i) + 1, Y(sh[i]), Math.max(1, X(i + 1) - X(i) - 2), Y(0) - Y(sh[i]));
      }
    }
    ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(X(0), Y(0));
    for (let i = 0; i < bins; i++) { ctx.lineTo(X(i), Y(sh[i])); ctx.lineTo(X(i + 1), Y(sh[i])); }
    ctx.lineTo(X(bins), Y(0));
    ctx.stroke();
  });

  return {
    hit(px) {
      if (px < padL || px > W - padR) return null;
      const i = Math.min(bins - 1, Math.floor(((px - padL) / pw) * bins));
      const a = i >= nb ? hi : edge(i), b = i >= nb ? Infinity : edge(i + 1);
      return { x: X(i + 0.5), a, b, rows: series.map((s, si) => ({ label: s.label, color: s.color, share: shares[si][i] })) };
    },
  };
}

/** Loss over time: one bar per bucket, height the share of probes lost. */
export function drawLossBars(canvas, buckets, opts) {
  if (!canvas) return null;
  const { ctx, W, H } = setup(canvas);
  if (!buckets.length) { emptyMsg(ctx, W, H, opts.empty || ''); return null; }
  let top = 0;
  for (const b of buckets) if (b.sent) top = Math.max(top, (b.lost / b.sent) * 100);
  const padT = 10, padB = 18, padR = 10;
  // yAxis pads the top by a tenth; a share cannot pass 100 %, so neither does the axis.
  const { Y, padL } = yAxis(ctx, { lo: 0, hi: Math.min(Math.max(top, 1), 100 / 1.1), zero: true, unit: '%', padT, H, padB, W, padR });
  const { x0, x1 } = opts;
  const span = Math.max(1, x1 - x0), pw = W - padL - padR;
  const X = (tv) => padL + ((tv - x0) / span) * pw;
  xAxis(ctx, { x0, x1, X, padL, W, padR, H, fmtX: opts.fmtX });
  const err = css('--err', '#ef4444');
  const muted = css('--border-hi', '#3a3a3a');
  for (const b of buckets) {
    const xa = X(b.t0), xb = X(b.t1);
    const w = Math.max(1, xb - xa - (xb - xa > 4 ? 2 : 0));     // 2px gap when there is room
    if (!b.sent) continue;
    if (!b.lost) { ctx.fillStyle = muted; ctx.fillRect(xa, Y(0) - 1, w, 1); continue; }
    const yy = Math.max(Y(100), Y((b.lost / b.sent) * 100));
    ctx.fillStyle = err;
    ctx.fillRect(xa, yy, w, Math.max(1, Y(0) - yy));
  }
  return {
    hit(px) {
      if (px < padL || px > W - padR) return null;
      const tv = x0 + ((px - padL) / pw) * span;
      const b = buckets.find((k) => tv >= k.t0 && tv < k.t1);
      return b && b.sent ? { x: (X(b.t0) + X(b.t1)) / 2, bucket: b } : null;
    },
  };
}

/**
 * Hour of day. Rows are targets, columns the 24 hours; a cell's fill is that
 * hour's median round trip on one sequential ramp shared by the whole grid,
 * and an hour that lost anything is outlined in red with its loss printed —
 * colour alone never carries the finding.
 */
export function drawHeat(canvas, rows, opts = {}) {
  if (!canvas) return null;
  const { ctx, W, H } = setup(canvas);
  if (!rows.length) { emptyMsg(ctx, W, H, opts.empty || ''); return null; }
  // Each row on its own ramp: the question is "is this host worse at 21:00
  // than it usually is", and on a shared scale the slower host is simply
  // bright everywhere and the faster one dark everywhere.
  for (const r of rows) {
    r.lo = Infinity; r.hi = -Infinity;
    for (const c of r.cells) if (c.p50 != null) { r.lo = Math.min(r.lo, c.p50); r.hi = Math.max(r.hi, c.p50); }
  }
  const padT = 4, padB = 16, padR = 8;
  let labW = 0;
  for (const r of rows) labW = Math.max(labW, ctx.measureText(r.label).width);
  const padL = Math.min(Math.ceil(labW) + 12, W * 0.3);
  const cw = (W - padL - padR) / 24;
  const rh = Math.min(34, (H - padT - padB) / rows.length);
  const dim = [42, 36, 16], hot = [251, 191, 36];
  const frac = (r, v) => (r.hi > r.lo ? (v - r.lo) / (r.hi - r.lo) : 0.35);
  const ramp = (f) => {
    const c = dim.map((d, i) => Math.round(d + (hot[i] - d) * f));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  };
  const err = css('--err', '#ef4444');
  ctx.textBaseline = 'middle';
  rows.forEach((r, ri) => {
    const y = padT + ri * rh;
    ctx.fillStyle = css('--text-sec', '#a3a3a3'); ctx.textAlign = 'right';
    let lab = r.label;
    while (lab.length > 3 && ctx.measureText(lab).width > padL - 10) lab = lab.slice(0, -2) + '…';
    ctx.fillText(lab, padL - 8, y + rh / 2);
    r.cells.forEach((c, h) => {
      const x = padL + h * cw;
      if (!c.n) { ctx.fillStyle = '#111'; ctx.fillRect(x + 1, y + 1, cw - 2, rh - 2); return; }
      const f = c.p50 != null ? frac(r, c.p50) : 0;
      ctx.fillStyle = c.p50 != null ? ramp(f) : '#1a1a1a';
      ctx.fillRect(x + 1, y + 1, cw - 2, rh - 2);
      if (c.lost) {
        ctx.strokeStyle = err; ctx.lineWidth = 1.5;
        ctx.strokeRect(x + 1.75, y + 1.75, cw - 3.5, rh - 3.5);
        if (cw > 26 && rh > 14) {
          ctx.fillStyle = f > 0.55 ? '#050505' : '#fff'; ctx.textAlign = 'center';
          const pctLost = (c.lost / c.n) * 100;
          ctx.fillText(pctLost >= 10 ? Math.round(pctLost) + '%' : pctLost.toFixed(1), x + cw / 2, y + rh / 2);
        }
      }
    });
  });
  ctx.fillStyle = css('--text-muted', '#666'); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  const every = cw < 18 ? 3 : cw < 30 ? 2 : 1;
  for (let h = 0; h < 24; h += every) ctx.fillText(String(h).padStart(2, '0'), padL + h * cw + cw / 2, H);
  return {
    hit(px, py) {
      const h = Math.floor((px - padL) / cw), ri = Math.floor((py - padT) / rh);
      if (h < 0 || h > 23 || ri < 0 || ri >= rows.length) return null;
      const c = rows[ri].cells[h];
      return c.n ? { x: padL + h * cw + cw / 2, hour: h, row: rows[ri], cell: c } : null;
    },
  };
}
