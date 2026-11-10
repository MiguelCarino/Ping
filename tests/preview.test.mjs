// Report preview tests: node --test tests/preview.test.mjs
// The preview frame holds the report exactly as reportHtml() writes it, plus one
// <style> whose rules apply on screen only. What prints must be the report.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document ??= { documentElement: { lang: 'en' } };
const { reportHtml, PAGE_MARGIN_MM } = await import('../js/report.js');
const { framedHtml } = await import('../js/preview.js');

const snap = { label: 'example.com', sent: 10, loss: 0, min: 10, mean: 12, p50: 12, p95: 14, max: 15, jitter: 1 };
const logReport = () => reportHtml({
  summary: { sent: 10, min: 10, mean: 12, p95: 14, max: 15, loss: 0 },
  targets: [snap],
  extremes: [],
  lossEvents: [],
  verdict: 'Clean line',
  method: 'Read from a saved log.',
  chart: { x0: 0, x1: 9000, series: [] },
  source: {
    file: 'ping.txt', size: '1 kB', format: 'Linux', encoding: 'UTF-8', basis: 'from the log',
    span: '00:00 – 00:09', sessions: 1, lines: 12, unparsed: 0, range: '',
    checks: { checked: 0, matched: 0, issues: [] },
  },
});

/** The preview's own style block, and the document with it taken out again. */
function split(html) {
  const m = html.match(/<style id="pvStyle">([\s\S]*?)<\/style>/);
  assert.ok(m, 'preview style present');
  return { css: m[1], rest: html.replace(m[0], '') };
}

test('the framed document is the report, plus one style block in the head', () => {
  const html = logReport();
  for (const paper of ['a4', 'letter']) {
    const framed = framedHtml(html, paper);
    const { rest } = split(framed);
    assert.equal(rest, html, 'nothing else changed');
    assert.ok(framed.indexOf('id="pvStyle"') < framed.indexOf('</head>'), 'in the head');
  }
});

test('every layout rule the preview adds is screen-only; print only hides the page-end lines', () => {
  const { css } = split(framedHtml(logReport(), 'letter'));
  const top = css.replace(/@media screen \{[\s\S]*?\n\}/, '').replace(/@media print \{[^}]*\}\s*\}/, '').trim();
  assert.equal(top, '', `no rule outside a media block: ${top}`);
  const print = css.match(/@media print \{([\s\S]*)\}/)[1];
  assert.match(print, /\.pv-break \{ display: none !important; \}/);
  assert.doesNotMatch(print, /\.sheet|\.toolbar|body/);
});

test('the sheet is the paper content width, with the report\'s own @page margins', () => {
  const html = logReport();
  assert.match(html, new RegExp(`@page \\{ margin: ${PAGE_MARGIN_MM.top}mm ${PAGE_MARGIN_MM.side}mm; \\}`));
  const width = (paper) => Number(split(framedHtml(html, paper)).css.match(/\.sheet \{[^}]*width: ([\d.]+)mm/)[1]);
  assert.equal(width('a4'), 210 - 2 * PAGE_MARGIN_MM.side);
  assert.equal(width('letter'), +(215.9 - 2 * PAGE_MARGIN_MM.side).toFixed(1));
  assert.equal(width('nonsense'), width('a4'), 'unknown paper falls back to A4');
  const { css } = split(framedHtml(html, 'a4'));
  assert.match(css, new RegExp(`padding: ${PAGE_MARGIN_MM.top}mm ${PAGE_MARGIN_MM.side}mm`));
  assert.match(css, /\.toolbar \{ display: none !important; \}/);
});

test('the report keeps its own level switch and print button for the frame to drive', () => {
  const html = logReport();
  assert.match(html, /data-l="basic"/);
  assert.match(html, /data-l="advanced"/);
  assert.match(html, /ping\.reportLevel/);
  assert.match(html, /\.toolbar \{ display: none; \}/, 'the toolbar never prints');
});

const { fileDocument, pdfPage } = await import('../js/preview.js');

test('the saved file is the report at the level shown, without its toolbar or script', () => {
  const html = logReport();
  for (const level of ['basic', 'advanced']) {
    const file = fileDocument(html, level);
    assert.doesNotMatch(file, /<script/i, 'no script');
    assert.doesNotMatch(file, /class="toolbar"/, 'no toolbar');
    assert.doesNotMatch(file, /\son[a-z]+=/i, 'no event attributes');
    assert.ok(file.includes('<body data-level="' + level + '">'), 'the level shown');
    assert.ok(file.includes('<div class="sheet">'), 'the sheet is all there');
    assert.ok(file.includes('<title>'), 'keeps its title');
  }
  assert.match(fileDocument(html, 'nonsense'), /<body data-level="basic">/, 'an unknown level is Basic');
  // Only the toolbar, the script and the level differ from the report.
  const strip = (s) => {
    const a = s.indexOf('<div class="toolbar">');
    const b = s.indexOf('</div>', s.indexOf('class="print"')) + '</div>'.length;
    const c = s.indexOf('<script>'), d = s.indexOf('</script>') + '</script>'.length;
    return (s.slice(0, a) + s.slice(b, c) + s.slice(d)).replace(/\n\n+/g, '\n');
  };
  const norm = (s) => s.replace(/\n\n+/g, '\n');
  assert.equal(norm(fileDocument(html, 'basic')), strip(html));
});

test('the PDF is laid out on the paper chosen, with the report\'s @page margins', () => {
  const m = [PAGE_MARGIN_MM.top, PAGE_MARGIN_MM.side, PAGE_MARGIN_MM.top, PAGE_MARGIN_MM.side];
  assert.deepEqual(pdfPage('a4'), { w: 210, h: 297, margin: m });
  assert.deepEqual(pdfPage('letter'), { w: 215.9, h: 279.4, margin: m });
  assert.deepEqual(pdfPage('nonsense'), pdfPage('a4'));
});
