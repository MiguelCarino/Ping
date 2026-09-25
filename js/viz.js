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
    lightness that holds up on near-black. */
export function seriesColor(i) {
  const fixed = [css('--accent', '#eab308'), '#38bdf8', '#a78bfa', '#f472b6', '#34d399', '#fb923c'];
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
