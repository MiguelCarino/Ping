// Parser tests: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decode, parseLog } from '../js/parse.js';

const fx = (name, opts) => {
  const { text, encoding } = decode(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
  const r = parseLog(text, { refYear: 2026, ...opts });
  r.encoding = encoding;
  return r;
};
const statuses = (r) => r.samples.map((s) => s.status).join(',');

test('linux: gap inference, DUP, unreachable, tail from summary, check passes', () => {
  const r = fx('linux.txt');
  assert.equal(r.format, 'linux');
  assert.equal(r.targets[0].label, 'google.com');
  assert.equal(r.targets[0].ip, '142.250.72.14');
  assert.equal(statuses(r), 'ok,ok,timeout,ok,ok,dup,unreachable,timeout,timeout');
  assert.equal(r.samples[2].inferred, true);
  assert.equal(r.dups, 1);
  assert.equal(r.sessions[0].check.ok, true, JSON.stringify(r.sessions[0].check));
  assert.equal(r.sessions[0].check.tail, 2);
  assert.equal(r.basis, 'estimated');
  assert.equal(r.samples[3].at - r.samples[0].at, 3000);
});

test('linux -D: absolute time, inferred samples interpolated', () => {
  const r = fx('linux-D.txt');
  assert.equal(r.basis, 'absolute');
  assert.equal(statuses(r), 'ok,ok,timeout,timeout,ok');
  assert.equal(Math.round(r.samples[2].at), 1760886002102);
  assert.equal(r.samples[4].ttl, 56);
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
  assert.equal(r.samples[3].lt, true);
  assert.equal(r.samples[2].from, '192.168.1.1');
  assert.equal(r.sessions[0].check.ok, true, JSON.stringify(r.sessions[0].check));
  // a Windows timeout is charged the 4 s it waited
  assert.equal(r.samples[2].at - r.samples[1].at, 4000);
});

for (const [file, lang] of [['windows-es.txt', 'es'], ['windows-es.cp850.txt', 'es'], ['windows-es.utf16.txt', 'es'],
  ['windows-ja.txt', 'ja'], ['windows-ja.sjis.txt', 'ja'], ['windows-ru.txt', 'ru'], ['windows-ru.cp866.txt', 'ru'], ['windows-pt.txt', 'pt']]) {
  test(`windows ${lang} (${file})`, () => {
    const r = fx(file);
    assert.equal(r.format, 'windows');
    assert.equal(r.lang, lang);
    assert.equal(r.unparsedCount, 0, JSON.stringify(r.unparsed));
    assert.ok(r.samples.some((s) => s.status === 'timeout'));
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
  const d = new Date(r.samples[0].at);
  assert.equal(d.getMonth(), 9);
  assert.equal(d.getDate(), 19);
  assert.equal(d.getHours(), 9);
  assert.equal(new Date(r.samples[3].at).getHours(), 10);
});

test('ts wrapper: named month, no year, gap inferred across midnight', () => {
  const r = fx('ts-wrapped.txt');
  assert.equal(r.format, 'linux');
  assert.equal(r.basis, 'absolute');
  assert.equal(statuses(r), 'ok,ok,timeout,timeout,ok');
  assert.equal(new Date(r.samples[4].at).getDate(), 20);
  assert.equal(new Date(r.samples[0].at).getFullYear(), 2026);
});

test('clock-only prefix rolls over midnight', () => {
  const r = fx('clock.txt');
  assert.equal(r.basis, 'clock');
  assert.equal(r.samples[1].at - r.samples[0].at, 1000);
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
  assert.equal(r.samples[1].rtt, 15);
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
  assert.equal(r.samples.length, 0);
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
  assert.ok(r.samples.length > 65000);
});

test('large log parses quickly', () => {
  const lines = ['PING big (10.0.0.1) 56(84) bytes of data.'];
  for (let i = 1; i <= 200000; i++) if (i % 97) lines.push(`64 bytes from 10.0.0.1: icmp_seq=${i % 65536} ttl=64 time=${(1 + (i % 7) / 10).toFixed(1)} ms`);
  const t0 = performance.now();
  const r = parseLog(lines.join('\n'));
  const dt = performance.now() - t0;
  console.log(`200k lines: ${dt.toFixed(0)} ms`);
  assert.equal(r.samples.filter((s) => s.status !== 'dup').length, 200000);
  assert.equal(r.samples.filter((s) => s.inferred).length, Math.floor(200000 / 97));
  assert.ok(dt < 4000, `took ${dt} ms`);
});
