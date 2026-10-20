/* report.js — the deliverable, built the way Topo builds its one.

   Two decisions inherited from topo.carino.systems, both deliberate:

   1. The document is standalone HTML with its styles inline, opened in a new
      tab with a Print button. Turning it into a PDF is the browser's job, which
      is why there is no PDF library here — and why removing jsPDF took ~900 kB
      of vendored script out of this repo. The file survives being emailed,
      archived, or opened on a machine that has never heard of this tool.
   2. No analysis lives in this file. Every number it prints is one the
      statistics module already computed for the screen. If the report and the
      screen ever disagree, one of them is lying.

   What changed from the previous report: it no longer dumps every sample. A
   run at half-second intervals against four targets produces ~500 rows an hour,
   and nobody has ever read row 300. What a reader needs is the distribution —
   average, the spread, and the handful of samples at each extreme, because the
   peaks are where the story is. The full record still exists: that is what the
   CSV and spreadsheet exports are for, and the report says so.

   Two levels on one sheet. Basic is what a client or a manager reads: the
   verdict, the headline numbers, the charts and a short per-target table.
   Advanced adds what the person fixing the network needs. Both live in the
   same file and a switch at the top flips a class, so the document stays one
   self-contained page and prints whichever level is on screen. */

const A = '#eab308';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const ms = (v, dp = 1) => (v == null ? '—' : `${v.toFixed(dp)} ms`);
const pct = (v) => (v == null ? '—' : `${v.toFixed(1)} %`);

function styles() {
  return `
  /* Margins only, and deliberately no paper size: forcing A4 makes a Letter
     printer scale the page, and Carta is what most of this report's readers
     have loaded. */
  @page { margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #f1f5f9; color: #0f172a;
         font: 13px/1.5 "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .sheet { max-width: 210mm; margin: 0 auto; background: #fff; padding: 18mm 16mm; box-shadow: 0 1px 3px rgba(15,23,42,0.15); }
  h1 { font-size: 21px; margin: 0 0 2px; letter-spacing: -0.01em; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #475569;
       margin: 26px 0 8px; padding-bottom: 5px; border-bottom: 1px solid #e2e8f0; page-break-after: avoid; }
  p { margin: 0 0 8px; }
  .sub { color: #64748b; font-size: 12px; margin: 0 0 14px; }
  .rule { height: 3px; background: ${A}; margin: 0 0 14px; }

  .meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px 24px; margin-bottom: 6px; }
  .meta div { display: flex; gap: 8px; font-size: 12px; border-bottom: 1px dotted #e2e8f0; padding: 3px 0; }
  .meta dt { color: #64748b; min-width: 104px; margin: 0; }
  .meta dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }

  /* Grid, not flex: flex items with min-width:auto can total wider than the
     page box and put the last tile's border under the margin. */
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(90px, 1fr)); gap: 8px; margin: 12px 0 4px; }
  .stat { border: 1px solid #e2e8f0; border-radius: 4px; padding: 8px 10px; min-width: 0; }
  .stat b { display: block; font-size: 19px; line-height: 1.15; }
  .stat span { font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: #64748b; }
  .stat.crit { border-color: #fecaca; background: #fef2f2; } .stat.crit b { color: #b91c1c; }
  .stat.adv  { border-color: #fde68a; background: #fffbeb; } .stat.adv b { color: #b45309; }
  .stat.good { border-color: #a7f3d0; background: #ecfdf5; } .stat.good b { color: #065f46; }

  table { width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 4px; }
  thead { display: table-header-group; }
  th { text-align: left; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.06em;
       color: #475569; border-bottom: 1.5px solid #cbd5e1; padding: 5px 6px; }
  td { padding: 5px 6px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  tr { page-break-inside: avoid; }
  td.r, th.r { text-align: right; }
  /* Numbers and verdicts must never wrap: "102 ms" broken over two lines reads
     as two values, and "0.0 %" as a fraction. Only the target column wraps, and
     it is given the room to need to. */
  td.nw, th.nw, .stat b, .sev { white-space: nowrap; }
  table.tgt { table-layout: fixed; }
  table.tgt th:nth-child(1), table.tgt td:nth-child(1) { width: 22px; }
  table.tgt th:nth-child(2), table.tgt td:nth-child(2) { width: 17%; }
  body[data-level="basic"] table.tgt th:nth-child(2), body[data-level="basic"] table.tgt td:nth-child(2) { width: 46%; }
  table.tgt .tm { width: 8%; }
  table.tgt .vd { width: 78px; }
  table.ext th:nth-child(2), table.ext td:nth-child(2) { width: 34%; }
  .mono { font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10.5px; overflow-wrap: anywhere; }
  .muted { color: #94a3b8; }
  .num { width: 26px; color: #94a3b8; }

  .sev { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 9.5px;
         font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; }
  .sev.bad { background: #fee2e2; color: #991b1b; }
  .sev.warn { background: #fef3c7; color: #92400e; }
  .sev.ok { background: #d1fae5; color: #065f46; }

  .clean { border: 1px solid #a7f3d0; background: #ecfdf5; color: #065f46; border-radius: 4px; padding: 10px 12px; }
  .alert { border: 1px solid #fecaca; background: #fef2f2; color: #991b1b; border-radius: 4px; padding: 10px 12px; }
  .note { font-size: 10.5px; color: #475569; background: #f8fafc; border-left: 3px solid #cbd5e1;
          padding: 9px 12px; margin: 8px 0; }
  .note b { color: #0f172a; }
  footer { margin-top: 26px; padding-top: 10px; border-top: 1px solid #e2e8f0;
           font-size: 10px; color: #94a3b8; display: flex; justify-content: space-between; gap: 12px; }

  .toolbar { max-width: 210mm; margin: 0 auto 12px; display: flex; justify-content: space-between;
             align-items: center; gap: 12px; flex-wrap: wrap; }
  .toolbar button { font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; border-radius: 4px; }
  .toolbar .print { background: #0f172a; color: #fff; border: 0; padding: 8px 16px; }
  .seg { display: inline-flex; border: 1px solid #cbd5e1; border-radius: 5px; background: #fff; padding: 2px; }
  .seg button { background: none; border: 0; color: #475569; padding: 6px 14px; }
  .seg button[aria-pressed="true"] { background: #0f172a; color: #fff; }

  /* Basic hides what only someone digging into the numbers needs. Printing
     prints the level on screen, so a one-page summary is one click away. */
  body[data-level="basic"] .more { display: none !important; }
  body[data-level="advanced"] .basic-only { display: none !important; }

  figure { margin: 6px 0 4px; break-inside: avoid; page-break-inside: avoid; }
  figure svg { display: block; width: 100%; height: auto; overflow: visible; }
  figcaption { font-size: 10.5px; color: #64748b; margin-top: 4px; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 11px; color: #334155; margin: 0 0 6px; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
  .ax { font-size: 9.5px; fill: #64748b; font-family: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace; }
  .lbl { font-size: 10.5px; fill: #0f172a; }

  /* Phones: one column of facts, charts and wide tables scroll sideways
     instead of shrinking to unreadable type. */
  .scroll { overflow-x: auto; }
  @media screen and (max-width: 640px) {
    body { padding: 10px; }
    .sheet { padding: 20px 16px; }
    .meta { grid-template-columns: 1fr; }
    figure { overflow-x: auto; }
    figure svg { min-width: 560px; }
    table.tgt { table-layout: auto; min-width: 100%; }
    table.tgt th, table.tgt td { width: auto !important; }
    body[data-level="advanced"] table.tgt { min-width: 640px; }
    footer { flex-direction: column; }
  }

  @media print {
    body { background: #fff; padding: 0; }
    .sheet { box-shadow: none; max-width: none; padding: 0; }
    .toolbar { display: none; }
    h2 { margin-top: 18px; }
  }`;
}

const stat = (value, label, cls) =>
  `<div class="stat${cls ? ' ' + cls : ''}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;

const row = (label, value, cls) => (value ? `<div${cls ? ` class="${cls}"` : ''}><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>` : '');

/** Shown at the foot of the Basic sheet, so nobody mistakes it for all there is. */
const basicNote = (t) => `<p class="basic-only muted" style="font-size:10.5px;margin-top:18px">${esc(t('Advanced (top of the page) adds the full statistics per target, the spread of each target, the peaks and lows, every gap in the replies and how the figures were measured.'))}</p>`;

/** Per-target distribution. The table the reader actually needs. */
/* A log report omits the Timing column: every sample in it is an ICMP reply
   from the ping command, so the column could only ever say one thing. */
function targetsTable(targets, t, log = false) {
  if (!targets.length) return `<p class="muted">${esc(t('No targets were measured.'))}</p>`;
  const rows = targets.map((s, i) => {
    const sev = s.loss >= 5 ? 'bad' : s.loss > 0 ? 'warn' : 'ok';
    const word = s.loss >= 5 ? t('Critical') : s.loss > 0 ? t('Advisory') : t('Clean');
    return `<tr>
      <td class="num">${i + 1}</td>
      <td class="mono">${esc(s.label)}</td>
      <td class="r nw more">${esc(s.sent)}</td>
      <td class="r nw">${esc(pct(s.loss))}</td>
      <td class="r nw more">${esc(ms(s.min))}</td>
      <td class="r nw"><b>${esc(ms(s.mean))}</b></td>
      <td class="r nw more">${esc(ms(s.p50))}</td>
      <td class="r nw more">${esc(ms(s.p95))}</td>
      <td class="r nw">${esc(ms(s.max))}</td>
      <td class="r nw more">${esc(ms(s.jitter))}</td>
      ${log ? '' : `<td class="more tm">${esc(s.detail ? 'TTFB' : t('total only'))}</td>`}
      <td class="vd"><span class="sev ${sev}">${esc(word)}</span></td>
    </tr>`;
  }).join('');
  return `<div class="scroll"><table class="tgt">
    <thead><tr>
      <th></th><th>${esc(t('Target'))}</th><th class="r more">${esc(t('Sent'))}</th><th class="r">${esc(t('Loss'))}</th>
      <th class="r more">${esc(t('Min'))}</th><th class="r">${esc(t('Average'))}</th><th class="r more">p50</th>
      <th class="r more">p95</th><th class="r">${esc(t('Max'))}</th><th class="r more">${esc(t('Jitter'))}</th>
      ${log ? '' : `<th class="more tm">${esc(t('Timing'))}</th>`}<th class="vd">${esc(t('Verdict'))}</th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** Peaks (biggest excursion above that target's own median) and per-target lows. */
const clockTime = (at) => new Date(at).toLocaleTimeString();

function extremesTable(extremes, t, fmt = clockTime) {
  if (!extremes.length) return '';
  const rows = extremes.map((e) => `<tr>
    <td><span class="sev ${e.kind === 'high' ? 'warn' : 'ok'}">${esc(e.kind === 'high' ? t('Peak') : t('Low'))}</span></td>
    <td class="mono">${esc(e.target)}</td>
    <td class="r nw">${esc(ms(e.rtt))}</td>
    <td class="r nw">${e.over != null ? '+' + esc(ms(e.over)) : '<span class="muted">—</span>'}</td>
    <td class="mono nw">${esc(fmt(e.at))}</td>
  </tr>`).join('');
  return `<table class="ext"><thead><tr>
      <th>${esc(t('Extreme'))}</th><th>${esc(t('Target'))}</th>
      <th class="r">${esc(t('Round trip'))}</th><th class="r">${esc(t('Over median'))}</th><th>${esc(t('Time'))}</th>
    </tr></thead><tbody>${rows}</tbody></table>
    <p class="muted" style="font-size:10.5px">${esc(t("Peaks are ranked by how far a sample sat above its own target's median, so a spike on a fast host still appears next to a slow host's normal traffic. Lows are each target's best sample."))}</p>`;
}

const KIND = { timeout: 'timeout', unreachable: 'unreachable', ttl: 'TTL exceeded', error: 'error' };

function lossTable(lossEvents, t, fmt = clockTime) {
  if (!lossEvents.length) {
    return `<div class="clean"><b>${esc(t('No probe went unanswered.'))}</b><br>${esc(t('Every request issued during this run came back.'))}</div>`;
  }
  const rows = lossEvents.map((e) => `<tr>
    <td class="mono">${esc(e.target)}</td>
    <td class="r">${esc(e.count)}</td>
    <td>${esc(e.kinds.map((k) => t(KIND[k] || k)).join(', '))}</td>
    <td class="mono">${esc(e.firstAt != null ? fmt(e.firstAt) : '—')}</td>
    <td class="mono">${esc(e.lastAt != null ? fmt(e.lastAt) : '—')}</td>
  </tr>`).join('');
  return `<table><thead><tr>
      <th>${esc(t('Target'))}</th><th class="r">${esc(t('Unanswered'))}</th>
      <th>${esc(t('Kind'))}</th><th>${esc(t('First'))}</th><th>${esc(t('Last'))}</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}


/* ---- charts -------------------------------------------------------------------

   Inline SVG, so the charts survive the same things the rest of the sheet
   does: being emailed, archived, printed, opened offline. The page's own
   colours are tuned for near-black; paper is white, so the report has its own
   steps of the same hues, in the same order (validated against #fff: worst
   adjacent pair ΔE 10.1 under protanopia). Loss is a status, not a series, and
   keeps the status red. */

const SERIES = ['#a16207', '#0284c7', '#db2777', '#7c3aed', '#059669', '#ea580c'];
const LOSS = '#dc2626';
const GRID = '#e2e8f0';
const color = (i) => SERIES[i % SERIES.length];

const W = 680;
const TSTEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400,
  172800, 604800].map((x) => x * 1000);

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

const pad2 = (n) => String(n).padStart(2, '0');
function defaultFmtX(v, step) {
  const d = new Date(v);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return step < 60000 ? `${hm}:${pad2(d.getSeconds())}` : hm;
}

/** Fold each series into n time buckets: min, mean, max of the replies, and
    how many probes were sent and lost. v is NaN for a lost probe. */
function bucketize(series, x0, x1, n) {
  const span = Math.max(1, x1 - x0);
  return series.map((s) => {
    const lo = new Float64Array(n).fill(NaN), hi = new Float64Array(n).fill(NaN);
    const sum = new Float64Array(n), cnt = new Uint32Array(n);
    const sent = new Uint32Array(n), lost = new Uint32Array(n);
    const T = s.t, V = s.v;
    for (let i = 0; i < T.length; i++) {
      const tt = T[i];
      if (!(tt >= x0 && tt <= x1)) continue;
      const b = Math.min(n - 1, Math.floor(((tt - x0) / span) * n));
      sent[b]++;
      const v = V[i];
      if (v !== v) { lost[b]++; continue; }
      if (!(v >= lo[b])) lo[b] = v;
      if (!(v <= hi[b])) hi[b] = v;
      sum[b] += v; cnt[b]++;
    }
    const mean = new Float64Array(n);
    for (let b = 0; b < n; b++) mean[b] = cnt[b] ? sum[b] / cnt[b] : NaN;
    return { label: s.label, lo, hi, mean, cnt, sent, lost };
  });
}

function xTicks(x0, x1, plotW, X, fmtX, y, h) {
  const span = Math.max(1, x1 - x0);
  const want = Math.max(2, Math.floor(plotW / 90));
  const step = TSTEPS.find((st) => span / st <= want) || TSTEPS[TSTEPS.length - 1];
  const off = new Date(x0).getTimezoneOffset() * 60000;
  let first = fmtX.utc ? Math.ceil(x0 / step) * step : Math.ceil((x0 - off) / step) * step + off;
  let out = '';
  for (let tv = first; tv <= x1; tv += step) {
    const xx = X(tv);
    if (xx < X(x0) + 14 || xx > X(x1) - 14) continue;
    out += `<line x1="${xx.toFixed(1)}" y1="${y}" x2="${xx.toFixed(1)}" y2="${y + 3}" stroke="#94a3b8"/>`
      + `<text class="ax" x="${xx.toFixed(1)}" y="${y + h}" text-anchor="middle">${esc(fmtX(tv, step))}</text>`;
  }
  return out;
}

function legend(labels) {
  if (labels.length < 2) return '';
  return `<div class="legend">${labels.map((l, i) => `<span><i style="background:${color(i)}"></i>${esc(l)}</span>`).join('')}</div>`;
}

/** Latency over time: each target's mean per bucket as a line, its min–max as
    a faint band. The scale is set by the means, so one 3-second spike does not
    flatten everything else into the floor; a band that runs off the top is
    clipped, and the peaks table names it. */
function latencySvg(b, x0, x1, fmtX, t) {
  const n = b[0].mean.length;
  const H = 222, pl = 44, pr = 8, pt = 20, pb = 22;
  const pw = W - pl - pr, ph = H - pt - pb;
  let top = 0;
  for (const s of b) for (let i = 0; i < n; i++) if (s.mean[i] > top) top = s.mean[i];
  if (!top) return '';
  const step = niceStep((top * 1.15) / 4);
  const yMax = Math.ceil((top * 1.15) / step) * step;
  const X = (v) => pl + ((v - x0) / Math.max(1, x1 - x0)) * pw;
  const xb = (i) => pl + ((i + 0.5) / n) * pw;
  const Y = (v) => pt + (1 - Math.min(v, yMax) / yMax) * ph;

  let grid = '';
  for (let v = 0; v <= yMax + 1e-9; v += step) {
    const yy = Y(v).toFixed(1);
    grid += `<line x1="${pl}" y1="${yy}" x2="${W - pr}" y2="${yy}" stroke="${GRID}"/>`
      + `<text class="ax" x="${pl - 6}" y="${(+yy + 3).toFixed(1)}" text-anchor="end">${+v.toFixed(3)}</text>`;
  }
  let marks = '';
  b.forEach((s, k) => {
    let band = '', line = '', open = false, seg = [];
    const flush = () => {
      if (seg.length > 1) {
        band += 'M' + seg.map((i) => `${xb(i).toFixed(1)} ${Y(s.hi[i]).toFixed(1)}`).join('L')
          + 'L' + seg.slice().reverse().map((i) => `${xb(i).toFixed(1)} ${Y(s.lo[i]).toFixed(1)}`).join('L') + 'Z';
      }
      seg = [];
    };
    for (let i = 0; i < n; i++) {
      if (s.mean[i] !== s.mean[i]) { open = false; flush(); continue; }
      line += (open ? 'L' : 'M') + xb(i).toFixed(1) + ' ' + Y(s.mean[i]).toFixed(1);
      open = true; seg.push(i);
    }
    flush();
    marks += `<path d="${band}" fill="${color(k)}" fill-opacity="${b.length > 1 ? 0.1 : 0.16}" stroke="none"/>`
      + `<path d="${line}" fill="none" stroke="${color(k)}" stroke-width="1.6" stroke-linejoin="round"/>`;
  });
  // One hit strip per bucket, so a viewer on screen can read the values.
  let hits = '';
  for (let i = 0; i < n; i++) {
    const parts = b.filter((s) => s.cnt[i]).map((s) => `${s.label}: ${s.mean[i].toFixed(1)} ms (${s.lo[i].toFixed(1)}–${s.hi[i].toFixed(1)})`);
    if (!parts.length) continue;
    hits += `<rect x="${(pl + (i / n) * pw).toFixed(1)}" y="${pt}" width="${(pw / n).toFixed(2)}" height="${ph}" fill="transparent"><title>${esc(parts.join('\n'))}</title></rect>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('Latency over time'))}">
    <defs><clipPath id="plot"><rect x="${pl}" y="${pt}" width="${pw}" height="${ph}"/></clipPath></defs>
    ${grid}
    <text class="ax" x="${pl - 6}" y="${pt - 10}" text-anchor="end">ms</text>
    <g clip-path="url(#plot)">${marks}</g>
    <line x1="${pl}" y1="${pt + ph}" x2="${W - pr}" y2="${pt + ph}" stroke="#94a3b8"/>
    ${xTicks(x0, x1, pw, X, fmtX, pt + ph, 14)}
    ${hits}
  </svg>`;
}

/** Share of probes lost per bucket, pooled over targets. */
function lossSvg(b, x0, x1, fmtX, t) {
  const n = b[0].sent.length;
  const sent = new Uint32Array(n), lost = new Uint32Array(n);
  let any = 0;
  for (const s of b) for (let i = 0; i < n; i++) { sent[i] += s.sent[i]; lost[i] += s.lost[i]; any += s.lost[i]; }
  if (!any) return '';
  let top = 0;
  for (let i = 0; i < n; i++) if (sent[i]) top = Math.max(top, (lost[i] / sent[i]) * 100);
  const yMax = top > 50 ? 100 : top > 20 ? 50 : top > 10 ? 20 : top > 5 ? 10 : 5;
  const H = 110, pl = 44, pr = 8, pt = 8, pb = 22;
  const pw = W - pl - pr, ph = H - pt - pb;
  const X = (v) => pl + ((v - x0) / Math.max(1, x1 - x0)) * pw;
  const Y = (v) => pt + (1 - v / yMax) * ph;
  const bw = pw / n;
  let grid = '';
  for (const v of [0, yMax / 2, yMax]) {
    const yy = Y(v).toFixed(1);
    grid += `<line x1="${pl}" y1="${yy}" x2="${W - pr}" y2="${yy}" stroke="${GRID}"/>`
      + `<text class="ax" x="${pl - 6}" y="${(+yy + 3).toFixed(1)}" text-anchor="end">${v} %</text>`;
  }
  let bars = '';
  for (let i = 0; i < n; i++) {
    if (!lost[i]) continue;
    const p = (lost[i] / sent[i]) * 100;
    // A single lost probe in a busy bucket still gets a visible sliver.
    const y = Math.min(Y(p), pt + ph - 1.5);
    bars += `<rect x="${(pl + i * bw + 0.5).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(2)}" height="${(pt + ph - y).toFixed(1)}" fill="${LOSS}" rx="1">`
      + `<title>${esc(`${lost[i]} / ${sent[i]} ${t('lost')} (${p.toFixed(1)} %)`)}</title></rect>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('Lost probes over time'))}">
    ${grid}${bars}
    <line x1="${pl}" y1="${pt + ph}" x2="${W - pr}" y2="${pt + ph}" stroke="#94a3b8"/>
    ${xTicks(x0, x1, pw, X, fmtX, pt + ph, 14)}
  </svg>`;
}

/** One row per target: min–max as a thin line, p50–p95 as a bar, the mean as
    a tick. Log scale once the spread passes 20×, which a single timeout-length
    outlier does easily. */
function spreadSvg(targets, t) {
  const rows = targets.filter((s) => s.min != null);
  if (!rows.length) return '';
  const lo = Math.max(0.1, Math.min(...rows.map((s) => s.min)));
  const hi = Math.max(...rows.map((s) => s.max));
  const log = hi / lo > 20;
  const pl = 170, pr = 12, rowH = 26, pt = 4;
  const H = pt + rows.length * rowH + 22;
  const pw = W - pl - pr;
  const a = log ? Math.log10(lo) : 0;
  const z = log ? Math.log10(hi) : hi * 1.05;
  const X = (v) => pl + (((log ? Math.log10(Math.max(v, lo)) : v) - a) / Math.max(1e-9, z - a)) * pw;
  let ticks = [];
  if (log) { for (let e = Math.floor(a); e <= Math.ceil(z); e++) for (const m of [1, 2, 5]) { const v = m * 10 ** e; if (v >= lo && v <= hi) ticks.push(v); } }
  else { const st = niceStep(z / 5); for (let v = 0; v <= z; v += st) ticks.push(v); }
  const base = pt + rows.length * rowH;
  let out = ticks.map((v) => `<line x1="${X(v).toFixed(1)}" y1="${pt}" x2="${X(v).toFixed(1)}" y2="${base}" stroke="${GRID}"/>`
    + `<text class="ax" x="${X(v).toFixed(1)}" y="${base + 14}" text-anchor="middle">${+v.toPrecision(3)}</text>`).join('');
  rows.forEach((s, i) => {
    const y = pt + i * rowH + rowH / 2;
    const k = targets.indexOf(s);
    const name = s.label.length > 26 ? s.label.slice(0, 25) + '…' : s.label;
    out += `<g><title>${esc(`${s.label}\n${t('Min')} ${ms(s.min)} · p50 ${ms(s.p50)} · p95 ${ms(s.p95)} · ${t('Max')} ${ms(s.max)} · ${t('Average')} ${ms(s.mean)}`)}</title>`
      + `<text class="lbl" x="${pl - 10}" y="${y + 3.5}" text-anchor="end">${esc(name)}</text>`
      + `<line x1="${X(s.min).toFixed(1)}" y1="${y}" x2="${X(s.max).toFixed(1)}" y2="${y}" stroke="#94a3b8" stroke-width="1.5"/>`
      + `<rect x="${X(s.p50).toFixed(1)}" y="${y - 6}" width="${Math.max(2, X(s.p95) - X(s.p50)).toFixed(1)}" height="12" rx="3" fill="${color(k)}"/>`
      + (s.mean != null ? `<line x1="${X(s.mean).toFixed(1)}" y1="${y - 9}" x2="${X(s.mean).toFixed(1)}" y2="${y + 9}" stroke="#0f172a" stroke-width="2"/>` : '')
      + '</g>';
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('Spread per target'))}">${out}</svg>`;
}

/** The chart block. `chart` is { x0, x1, fmtX?, series: [{ label, t, v }] }. */
function chartsHtml(chart, targets, t) {
  if (!chart || !chart.series.length || !(chart.x1 > chart.x0)) return '';
  const fmtX = chart.fmtX || defaultFmtX;
  const b = bucketize(chart.series, chart.x0, chart.x1, 240);
  const lat = latencySvg(b, chart.x0, chart.x1, fmtX, t);
  const loss = lossSvg(bucketize(chart.series, chart.x0, chart.x1, 120), chart.x0, chart.x1, fmtX, t);
  const spread = spreadSvg(targets, t);
  return `
  <h2>${esc(t('Latency over time'))}</h2>
  ${legend(chart.series.map((s) => s.label))}
  ${lat ? `<figure>${lat}<figcaption>${esc(t('The line is the average round trip in each slice of time; the shaded band runs from its fastest to its slowest reply.'))}</figcaption></figure>` : ''}
  ${loss ? `<figure>${loss}<figcaption>${esc(t('Share of probes that went unanswered in each slice of time, all targets together.'))}</figcaption></figure>` : ''}
  ${spread ? `<div class="more"><h2>${esc(t('Spread per target'))}</h2>
  <figure>${spread}<figcaption>${esc(t('The thin line runs from the fastest to the slowest reply, the bar from the median (p50) to the 95th percentile (p95), and the dark tick is the average.'))}</figcaption></figure></div>` : ''}`;
}

/**
 * @param model {{
 *   summary, targets, extremes, lossEvents, verdict,
 *   env, speed, stun, run: {started, ended, interval, timeout, path, samples}
 * }}
 */
export function reportHtml(model, t = (x) => x) {
  if (model.source) return logReportHtml(model, t);
  const { summary, env, speed, stun, run } = model;
  const publicHost = model.hostname || (stun && stun.publicIP) || null;
  const conn = env.connection;
  const title = t('Network latency report');
  const when = new Date(run.started);

  const dur = run.ended && run.started
    ? Math.max(1, Math.round((run.ended - run.started) / 1000))
    : null;

  const body = `<div class="sheet">
  <div class="rule"></div>
  <h1>${esc(title)}</h1>
  <p class="sub">${esc(run.targetsLabel || '')}</p>

  <dl class="meta">
    ${row(t('Client'), env.id)}
    ${row(t('Date'), when.toLocaleString())}
    ${row(t('Browser'), env.browser, 'more')}
    ${row(t('Platform'), env.platform, 'more')}
    ${row(t('Time zone'), `${env.timezone} (UTC${env.utcOffsetMin >= 0 ? '+' : ''}${Math.round(env.utcOffsetMin / 60)})`, 'more')}
    ${row(t('Public host'), publicHost
    ? (model.hostname && stun && stun.publicIP ? `${model.hostname} (${stun.publicIP})` : publicHost)
    : t('not determined'))}
    ${row(t('Run length'), dur ? `${dur} s` : '—')}
    ${row(t('Probe interval'), `${run.interval} ms`, 'more')}
    ${row(t('Probe path'), run.path, 'more')}
    ${row(t('Timeout'), `${run.timeout} ms`, 'more')}
  </dl>

  <h2>${esc(t('Summary'))}</h2>
  <div class="stats">
    ${stat(summary.sent, t('Requests'))}
    ${stat(ms(summary.min, 0), t('Best'), 'more')}
    ${stat(ms(summary.mean, 0), t('Average'))}
    ${stat(ms(summary.p95, 0), t('95th pct'), 'more')}
    ${stat(ms(summary.max, 0), t('Worst'))}
    ${stat(pct(summary.loss), t('Loss'), summary.loss >= 5 ? 'crit' : summary.loss > 0 ? 'adv' : 'good')}
  </div>
  <div class="${summary.loss >= 5 || (summary.p95 != null && summary.p95 > 250) ? 'alert' : 'clean'}">
    <b>${esc(t('Assessment'))}:</b> ${esc(model.verdict)}
  </div>

  <h2>${esc(t('Connection'))}</h2>
  <div class="stats">
    ${stat(speed && speed.mbps != null ? (speed.mbps >= 100 ? Math.round(speed.mbps) : speed.mbps.toFixed(1)) : '—', t('Mbit/s down'))}
    ${stat(stun && stun.rtt != null ? ms(stun.rtt, 0) : '—', t('STUN round trip'))}
    ${stat(conn.effectiveType || '—', t('Effective type'), 'more')}
    ${stat(conn.type || t('not published'), t('Interface'), 'more')}
  </div>
  <div class="note more">
    <b>${esc(t('Downlink'))}:</b> ${esc(speed && speed.mbps != null
    ? t('measured before the latency run, over {n} parallel streams from a CDN, on an otherwise idle link. A lower bound on the line, not a substitute for a speed test with a nearby server.').replace('{n}', speed.streams)
    : t('not measured for this run.'))}<br>
    <b>${esc(t('Interface'))}:</b> ${esc(t('No web API reports the network interface in use. Browsers replace the local address with a random .local name specifically so a page cannot enumerate the network, so a wired/wireless answer is only available where the operating system publishes it — Chromium on Android and ChromeOS. Everywhere else this field reads "not published" rather than guessing.'))}
  </div>

  ${chartsHtml(model.chart, model.targets, t)}

  <h2>${esc(t('Per target'))}</h2>
  ${targetsTable(model.targets, t)}
  <p class="muted more" style="font-size:10.5px">${esc(t('Average is the arithmetic mean of answered probes. The first request to each host is excluded throughout: it pays DNS and the TLS handshake and is not representative of the steady state.'))}</p>

  <div class="more">
  <h2>${esc(t('Peaks and lows'))}</h2>
  ${extremesTable(model.extremes, t)}

  <h2>${esc(t('Unanswered probes'))}</h2>
  ${lossTable(model.lossEvents, t)}

  <h2>${esc(t('Method and limits'))}</h2>
  <div class="note">${esc(model.method)}</div>
  <p class="muted" style="font-size:10.5px">${esc(t('This report summarises {n} samples. The complete per-sample record is not printed here by design — export CSV, XLSX or ODS from the tool for that.').replace('{n}', run.samples))}</p>
  </div>
  ${basicNote(t)}

  <footer>
    <span>${esc(env.id)}</span>
    <span>${esc(t('Generated with Ping · ping.carino.systems'))}</span>
  </footer>
</div>`;

  return wrap(`${title}${run.targetsLabel ? ' — ' + run.targetsLabel : ''}`, body, t);
}

function wrap(title, body, t) {
  return `<!DOCTYPE html>
<html lang="${esc(document.documentElement.lang || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${styles()}</style>
</head>
<body data-level="basic">
<div class="toolbar">
  <div class="seg" role="group" aria-label="${esc(t('Detail'))}">
    <button type="button" data-l="basic" aria-pressed="true">${esc(t('Basic'))}</button>
    <button type="button" data-l="advanced" aria-pressed="false">${esc(t('Advanced'))}</button>
  </div>
  <button type="button" class="print" onclick="window.print()">${esc(t('Print / Save as PDF'))}</button>
</div>
${body}
<script>
(function () {
  var K = 'ping.reportLevel', btns = document.querySelectorAll('[data-l]');
  function set(l) {
    document.body.setAttribute('data-level', l);
    for (var i = 0; i < btns.length; i++) btns[i].setAttribute('aria-pressed', String(btns[i].getAttribute('data-l') === l));
    try { localStorage.setItem(K, l); } catch (e) {}
  }
  var saved = null;
  try { saved = localStorage.getItem(K); } catch (e) {}
  if (saved === 'advanced') set(saved);
  for (var i = 0; i < btns.length; i++) btns[i].onclick = function () { set(this.getAttribute('data-l')); };
})();
</script>
</body>
</html>`;
}

/**
 * The same sheet for a saved log. What changes is the provenance: there is no
 * connection to describe — the run happened somewhere else, some time ago —
 * so the header names the file, how it was read, and what time axis it had,
 * and a section reports the cross-check against ping's own summaries.
 *
 * @param model {{ summary, targets, extremes, lossEvents, verdict, method,
 *   fmtTime, source: { file, size, format, encoding, basis, span, sessions,
 *   lines, unparsed, checks: { checked, matched, issues: [{line, target, text}] } } }}
 */
function logReportHtml(model, t) {
  const { summary, source: src } = model;
  const title = t('Ping log report');
  const fmt = model.fmtTime || clockTime;
  const chk = src.checks;

  const checkBlock = !chk.checked
    ? `<p class="muted">${esc(t('This log carries no summary blocks, so there was nothing to cross-check against.'))}</p>`
    : chk.matched === chk.checked
      ? `<div class="clean"><b>${esc(t('Every summary matches.'))}</b><br>${esc(t('{n} of {m} summary blocks agree with the parsed samples — sent, received, min, average and max.').replace('{n}', chk.matched).replace('{m}', chk.checked))}</div>`
      : `<div class="alert"><b>${esc(t('{n} of {m} summary blocks disagree.').replace('{n}', chk.checked - chk.matched).replace('{m}', chk.checked))}</b></div>
        <table><thead><tr><th>${esc(t('Line'))}</th><th>${esc(t('Target'))}</th><th>${esc(t('Difference'))}</th></tr></thead><tbody>
        ${chk.issues.slice(0, 20).map((x) => `<tr><td class="mono nw">${esc(x.line)}</td><td class="mono">${esc(x.target)}</td><td>${esc(x.text)}</td></tr>`).join('')}
        </tbody></table>`;

  const body = `<div class="sheet">
  <div class="rule"></div>
  <h1>${esc(title)}</h1>
  <p class="sub">${esc(src.file)}</p>

  <dl class="meta">
    ${row(t('File'), src.file)}
    ${row(t('Size'), src.size, 'more')}
    ${row(t('Format'), src.format)}
    ${row(t('Encoding'), src.encoding, 'more')}
    ${row(t('Time'), src.basis, 'more')}
    ${row(t('Span'), src.span)}
    ${row(t('Targets'), model.targets.map((x) => x.label).join(', '))}
    ${row(t('Sessions'), String(src.sessions), 'more')}
    ${row(t('Lines'), String(src.lines), 'more')}
    ${row(t('Unrecognised lines'), String(src.unparsed), 'more')}
    ${row(t('Filtered to'), src.range || '')}
  </dl>

  <h2>${esc(t('Summary'))}</h2>
  <div class="stats">
    ${stat(summary.sent, t('Probes'))}
    ${stat(ms(summary.min, 0), t('Best'), 'more')}
    ${stat(ms(summary.mean, 0), t('Average'))}
    ${stat(ms(summary.p95, 0), t('95th pct'), 'more')}
    ${stat(ms(summary.max, 0), t('Worst'))}
    ${stat(pct(summary.loss), t('Loss'), summary.loss >= 5 ? 'crit' : summary.loss > 0 ? 'adv' : 'good')}
  </div>
  <div class="${summary.loss >= 5 || (summary.p95 != null && summary.p95 > 250) ? 'alert' : 'clean'}">
    <b>${esc(t('Assessment'))}:</b> ${esc(model.verdict)}
  </div>

  ${chartsHtml(model.chart, model.targets, t)}

  <h2>${esc(t('Per target'))}</h2>
  ${targetsTable(model.targets, t, true)}

  <div class="more">
  <h2>${esc(t('Peaks and lows'))}</h2>
  ${extremesTable(model.extremes, t, fmt)}

  <h2>${esc(t('Unanswered probes'))}</h2>
  ${lossTable(model.lossEvents, t, fmt)}

  <h2>${esc(t('Cross-check against ping'))}</h2>
  ${checkBlock}

  <h2>${esc(t('Method and limits'))}</h2>
  <div class="note">${esc(model.method)}</div>
  <p class="muted" style="font-size:10.5px">${esc(t('This report summarises {n} samples. The complete per-sample record is not printed here by design — export CSV, XLSX or ODS from the tool for that.').replace('{n}', summary.sent))}</p>
  </div>
  ${basicNote(t)}

  <footer>
    <span>${esc(src.file)}</span>
    <span>${esc(t('Generated with Ping · ping.carino.systems'))}</span>
  </footer>
</div>`;
  return wrap(`${title} — ${src.file}`, body, t);
}

/** Open the report in a new tab, the way Topo does. */
export function openReport(html, t = (x) => x) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const tab = window.open(url, '_blank');
  if (!tab) {
    URL.revokeObjectURL(url);
    throw new Error(t('The report opens in a new tab — allow pop-ups for this site and try again.'));
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
