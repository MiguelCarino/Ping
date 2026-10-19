// Parser tests: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decode, parseLog, toObjects, createEngine } from '../js/parse.js';

const fx = (name, opts) => {
  const { text, encoding } = decode(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
  const r = parseLog(text, { refYear: 2026, ...opts });
  r.encoding = encoding;
  return r;
};
const S = (r) => (r._objs ||= toObjects(r));
const statuses = (r) => S(r).map((s) => s.status).join(',');

test('linux: gap inference, DUP, unreachable, tail from summary, check passes', () => {
  const r = fx('linux.txt');
  assert.equal(r.format, 'linux');
  assert.equal(r.targets[0].label, 'google.com');
  assert.equal(r.targets[0].ip, '142.250.72.14');
  assert.equal(statuses(r), 'ok,ok,timeout,ok,ok,dup,unreachable,timeout,timeout');
  assert.equal(S(r)[2].inferred, true);
  assert.equal(r.dups, 1);
  assert.equal(r.sessions[0].check.ok, true, JSON.stringify(r.sessions[0].check));
  assert.equal(r.sessions[0].check.tail, 2);
  assert.equal(r.basis, 'estimated');
  assert.equal(S(r)[3].at - S(r)[0].at, 3000);
});

test('linux -D: absolute time, inferred samples interpolated', () => {
  const r = fx('linux-D.txt');
  assert.equal(r.basis, 'absolute');
  assert.equal(statuses(r), 'ok,ok,timeout,timeout,ok');
  assert.equal(Math.round(S(r)[2].at), 1760886002102);
  assert.equal(S(r)[4].ttl, 56);
});

test('busybox: seq from 0, trailing loss from summary', () => {
  const r = fx('busybox.txt');
  assert.equal(r.format, 'busybox');
  assert.equal(statuses(r), 'ok,ok,timeout,ok,timeout');
  assert.equal(r.sessions[0].check.ok, true, JSON.stringify(r.sessions[0].check));
});

test('macos: explicit timeout, seq-less unreachable pinned, hex dump ignored', () => {
  const r = fx('macos.txt');
  assert.equal(r.format, 'bsd');
  assert.equal(statuses(r), 'ok,timeout,ok,unreachable,ok');
  assert.equal(r.unparsedCount, 0, JSON.stringify(r.unparsed));
  assert.equal(r.sessions[0].check.ok, true, JSON.stringify(r.sessions[0].check));
});

test('windows english: <1ms, unreachable counted the Windows way in the check', () => {
  const r = fx('windows-en.txt');
  assert.equal(r.format, 'windows');
  assert.equal(r.lang, 'en');
  assert.equal(statuses(r), 'ok,timeout,unreachable,ok');
  assert.equal(S(r)[3].lt, true);
  assert.equal(S(r)[2].from, '192.168.1.1');
  assert.equal(r.sessions[0].check.ok, true, JSON.stringify(r.sessions[0].check));
  // a Windows timeout is charged the 4 s it waited
  assert.equal(S(r)[2].at - S(r)[1].at, 4000);
});

for (const [file, lang] of [['windows-es.txt', 'es'], ['windows-es.cp850.txt', 'es'], ['windows-es.utf16.txt', 'es'],
  ['windows-ja.txt', 'ja'], ['windows-ja.sjis.txt', 'ja'], ['windows-ru.txt', 'ru'], ['windows-ru.cp866.txt', 'ru'], ['windows-pt.txt', 'pt']]) {
  test(`windows ${lang} (${file})`, () => {
    const r = fx(file);
    assert.equal(r.format, 'windows');
    assert.equal(r.lang, lang);
    assert.equal(r.unparsedCount, 0, JSON.stringify(r.unparsed));
    assert.ok(S(r).some((s) => s.status === 'timeout'));
    if (r.sessions[0].check) assert.equal(r.sessions[0].check.ok, true, JSON.stringify(r.sessions[0].check));
  });
}

test('encodings are detected', () => {
  assert.equal(fx('windows-es.cp850.txt').encoding, 'CP850');
  assert.equal(fx('windows-es.utf16.txt').encoding, 'UTF-16LE');
  assert.equal(fx('windows-ru.cp866.txt').encoding, 'CP866');
  assert.equal(fx('windows-ja.sjis.txt').encoding, 'Shift_JIS');
});

test('powershell Get-Date wrapper: absolute, M/D order from English', () => {
  const r = fx('ps-wrapped.txt');
  assert.equal(r.format, 'windows');
  assert.equal(r.basis, 'absolute');
  assert.equal(statuses(r), 'ok,ok,timeout,ok');
  const d = new Date(S(r)[0].at);
  assert.equal(d.getMonth(), 9);
  assert.equal(d.getDate(), 19);
  assert.equal(d.getHours(), 9);
  assert.equal(new Date(S(r)[3].at).getHours(), 10);
});

test('ts wrapper: named month, no year, gap inferred across midnight', () => {
  const r = fx('ts-wrapped.txt');
  assert.equal(r.format, 'linux');
  assert.equal(r.basis, 'absolute');
  assert.equal(statuses(r), 'ok,ok,timeout,timeout,ok');
  assert.equal(new Date(S(r)[4].at).getDate(), 20);
  assert.equal(new Date(S(r)[0].at).getFullYear(), 2026);
});

test('clock-only prefix rolls over midnight', () => {
  const r = fx('clock.txt');
  assert.equal(r.basis, 'clock');
  assert.equal(S(r)[1].at - S(r)[0].at, 1000);
});

test('powershell 7 table', () => {
  const r = fx('pwsh7.txt');
  assert.equal(r.format, 'pwsh');
  assert.equal(r.targets[0].label, 'google.com');
  assert.equal(statuses(r), 'ok,timeout,ok');
  assert.equal(r.unparsedCount, 0, JSON.stringify(r.unparsed));
});

test('powershell 5 table: one session per destination', () => {
  const r = fx('pwsh5.txt');
  assert.equal(r.format, 'pwsh');
  assert.deepEqual(r.targets.map((t) => t.label), ['google.com', '1.1.1.1']);
  assert.equal(S(r)[1].rtt, 15);
  assert.equal(r.unparsedCount, 0, JSON.stringify(r.unparsed));
});

test('own CSV round-trips', () => {
  const r = fx('carino.csv');
  assert.equal(r.format, 'csv');
  assert.equal(r.basis, 'absolute');
  assert.equal(r.targets.length, 2);
  assert.equal(statuses(r), 'ok,timeout,ok');
});

test('cron-style repeated runs: one target, two sessions, both checked', () => {
  const r = fx('multi-cron.txt');
  assert.equal(r.targets.length, 1);
  assert.equal(r.sessions.length, 2);
  assert.ok(r.sessions.every((s) => s.check && s.check.ok), JSON.stringify(r.sessions.map((s) => s.check)));
  assert.equal(statuses(r), 'ok,ok,timeout,ok,ok,ok');
});

test('forced format restricts the patterns', () => {
  const r = fx('linux.txt', { format: 'windows' });
  assert.equal(S(r).length, 0);
  assert.ok(r.unparsedCount > 5);
});

test('not a ping log', () => {
  const r = parseLog('hello\nworld\n');
  assert.equal(r.format, null);
});

test('seq wraps at 65535', () => {
  const lines = ['PING h (10.0.0.1) 56(84) bytes of data.'];
  for (const s of [65534, 65535, 0, 2]) lines.push(`64 bytes from 10.0.0.1: icmp_seq=${s} ttl=64 time=1.0 ms`);
  const r = parseLog(lines.join('\n'), { refYear: 2026 });
  // no 65 533 inferred losses before the first reply: the session had a header
  // starting at 1, so 1..65533 ARE inferred. Use a header-less log instead.
  const r2 = parseLog(lines.slice(1).join('\n'));
  assert.equal(statuses(r2), 'ok,ok,ok,timeout,ok');
  assert.ok(S(r).length > 65000);
});

test('large log parses quickly', () => {
  const lines = ['PING big (10.0.0.1) 56(84) bytes of data.'];
  for (let i = 1; i <= 200000; i++) if (i % 97) lines.push(`64 bytes from 10.0.0.1: icmp_seq=${i % 65536} ttl=64 time=${(1 + (i % 7) / 10).toFixed(1)} ms`);
  const t0 = performance.now();
  const r = parseLog(lines.join('\n'));
  const dt = performance.now() - t0;
  console.log(`200k lines: ${dt.toFixed(0)} ms`);
  assert.equal(S(r).filter((s) => s.status !== 'dup').length, 200000);
  assert.equal(S(r).filter((s) => s.inferred).length, Math.floor(200000 / 97));
  assert.ok(dt < 4000, `took ${dt} ms`);
});

test('tagged parallel pings: date + [target] + -D epoch, one stream per tag', () => {
  const r = fx('tagged-multi.txt');
  assert.equal(r.format, 'linux');
  assert.equal(r.basis, 'absolute');
  assert.deepEqual(r.targets.map((t) => t.label), ['1.1.1.1', '8.8.8.8', 'files.evacenter.com']);
  assert.equal(r.unparsedCount, 0, JSON.stringify(r.unparsed));
  const by = (i) => S(r).filter((s) => s.tgt === i).map((s) => s.status).join(',');
  assert.equal(by(0), 'ok,ok,ok,ok');
  assert.equal(by(1), 'ok,ok,ok,ok');
  // seq 3 never arrived for this one — inferred, and only in its own stream
  assert.equal(by(2), 'ok,ok,timeout,ok');
  // the epoch (microseconds) wins over the wrapper's whole-second date
  assert.equal(S(r)[0].at, 1790265676653.959);
  const inf = S(r).find((s) => s.inferred);
  assert.ok(inf.at > 1790265677724 && inf.at < 1790265679704);
  assert.equal(r.targets[2].ip, '3.161.188.59');
});

test('hard-wrapped lines are re-joined, line numbers kept', () => {
  const a = fx('tagged-multi.txt'), b = fx('tagged-multi-wrapped.txt');
  assert.equal(b.unparsedCount, 0, JSON.stringify(b.unparsed));
  assert.deepEqual(S(b).map((s) => [s.tgt, s.status, s.rtt]), S(a).map((s) => [s.tgt, s.status, s.rtt]));
  assert.ok(S(b)[S(b).length - 1].line > S(a)[S(a).length - 1].line);
});

test('tagged without a clock: parallel streams share the time axis', () => {
  const text = ['[a] PING 10.0.0.1 (10.0.0.1) 56(84) bytes of data.', '[b] PING 10.0.0.2 (10.0.0.2) 56(84) bytes of data.',
    '[a] 64 bytes from 10.0.0.1: icmp_seq=1 ttl=64 time=1.0 ms', '[b] 64 bytes from 10.0.0.2: icmp_seq=1 ttl=64 time=2.0 ms',
    '[a] 64 bytes from 10.0.0.1: icmp_seq=2 ttl=64 time=1.0 ms', '[b] 64 bytes from 10.0.0.2: icmp_seq=2 ttl=64 time=2.0 ms'].join('\n');
  const r = parseLog(text);
  assert.equal(r.basis, 'estimated');
  assert.deepEqual(S(r).map((s) => s.at), [0, 0, 1000, 1000]);
});


test('engine: streams a File in chunks, falls back from UTF-8 mid-file, serves lines', async () => {
  const enc = new TextEncoder();
  // Pure ASCII head, then CP850 bytes far past the 256 kB sniff window.
  const body = [];
  body.push('Haciendo ping a 8.8.8.8 con 32 bytes de datos:');
  for (let i = 0; i < 9000; i++) body.push('Respuesta desde 8.8.8.8: bytes=32 tiempo=12ms TTL=117');
  const head = enc.encode(body.join('\r\n') + '\r\n');
  const tail = Uint8Array.from([...enc.encode('\r\nEstad'), 0xA1, ...enc.encode('sticas de ping para 8.8.8.8:\r\n')]);
  const file = new File([head, tail], 'x.txt');
  const eng = createEngine();
  const seen = [];
  await eng.loadFile(file, (p) => seen.push(p.phase));
  assert.ok(seen.includes('read'));
  const r = eng.parse({ refYear: 2026 });
  assert.equal(r.format, 'windows');
  assert.equal(r.n, 9000);
  assert.ok(['CP850', 'Windows-1252'].includes(r.encoding), r.encoding);
  assert.deepEqual(eng.lines([1, 2, 9001]), ['Haciendo ping a 8.8.8.8 con 32 bytes de datos:',
    'Respuesta desde 8.8.8.8: bytes=32 tiempo=12ms TTL=117', 'Respuesta desde 8.8.8.8: bytes=32 tiempo=12ms TTL=117']);
});

test('engine: big log stays linear and columnar', async () => {
  const lines = ['PING big (10.0.0.1) 56(84) bytes of data.'];
  // -D stamps with a 20 000-packet outage in the middle: the interpolation
  // used to be quadratic in the gap.
  let t = 1760000000;
  for (let i = 1; i <= 300000; i++) {
    t += 1;
    if (i > 100000 && i <= 120000) continue;
    lines.push(`[${t}.000000] 64 bytes from 10.0.0.1: icmp_seq=${i % 65536} ttl=64 time=1.${i % 10} ms`);
  }
  const eng = createEngine();
  eng.loadText(lines.join('\n') + '\n');
  const t0 = performance.now();
  const r = eng.parse({});
  const dt = performance.now() - t0;
  console.log(`300k lines with a 20k outage: ${dt.toFixed(0)} ms`);
  assert.equal(r.n, 300000);
  assert.ok(r.cols.at instanceof Float64Array);
  assert.equal(r.basis, 'absolute');
  // inferred sample in the middle of the outage sits halfway in time
  const o = toObjects(r);
  const mid = o.find((s) => s.inferred && s.seq === 110000);
  assert.ok(mid && Math.abs(mid.at - (1760000000 + 110000) * 1000) < 2000, JSON.stringify(mid));
  assert.ok(dt < 4000);
});


test('date order is decided from across the file, stamp-only lines are blank', async () => {
  // 01/09 for the first 30 000 lines, 13/09 at the end: only a sample from
  // past the head can tell DD/MM from MM/DD.
  const out = ['01/09/2026 08:00:00 - ', '01/09/2026 08:00:00 - Haciendo ping a 10.1.1.1 con 32 bytes de datos:'];
  for (let i = 0; i < 30000; i++) out.push(`01/09/2026 08:${String(Math.floor(i / 600) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')} - Respuesta desde 10.1.1.1: bytes=32 tiempo=5ms TTL=63`);
  for (let i = 0; i < 30000; i++) out.push(`13/09/2026 09:00:${String(i % 60).padStart(2, '0')} - Respuesta desde 10.1.1.1: bytes=32 tiempo=5ms TTL=63`);
  const eng = createEngine();
  eng.loadText(out.join('\r\n') + '\r\n');
  const r = eng.parse({ refYear: 2026 });
  assert.equal(r.dateOrder, 'dmy');
  assert.equal(r.dateAmbiguous, false);
  assert.equal(r.unparsedCount, 0, JSON.stringify(r.unparsed.slice(0, 3)));
  assert.equal(new Date(r.cols.at[r.n - 1]).getDate(), 13);
});
