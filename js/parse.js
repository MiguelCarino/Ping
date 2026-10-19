/* parse.js — reads saved ping output back into samples.

   Pure functions, no DOM: the same module runs inside the parse worker, on the
   main thread when a worker cannot start, and under Node for the tests.

   What it understands:
     linux    iputils (Fedora, Debian, Ubuntu), including -D and -O
     busybox  Alpine, OpenWrt, most routers and containers (`seq=`, from 0)
     bsd      macOS and the BSDs (`Request timeout for icmp_seq N`)
     windows  `ping` / `ping -t`, in English, Spanish, Portuguese, Russian,
              Japanese, German and French — the output is localized, so the
              reply line is recognised by its structure, not its words
     pwsh     PowerShell Test-Connection, the 5.1 and the 7 table
     csv      this tool's own CSV, live or imported, so a run can be reloaded
   Any of the first five may carry a timestamp prefix from a wrapper — `ts`,
   `$(date)`, `Get-Date`, ISO, a bare clock — which is stripped first.

   Three things the formats do not tell you, and how they are recovered:

   1. Linux prints nothing for a lost packet unless -O was given. Loss is the
      gap in icmp_seq, so every missing sequence number becomes an inferred
      timeout, and lost packets after the last reply are recovered from the
      summary's "N packets transmitted". The 16-bit counter wraps at 65535.
   2. Most logs have no clock at all. Without -D or a wrapper the time axis is
      sequence × interval, and the result says so (`basis: 'estimated'`) so the
      screen can label it rather than pass it off as a measurement.
   3. The summary block is a free correctness check. Where one is printed, the
      parsed counts and min/avg/max are compared against it, per session. */

export const FORMATS = {
  linux: 'Linux (iputils)',
  busybox: 'BusyBox',
  bsd: 'macOS / BSD',
  windows: 'Windows',
  pwsh: 'PowerShell',
  csv: 'Carino Ping CSV',
};
const FAMILY = { linux: 'unix', busybox: 'unix', bsd: 'unix', windows: 'windows', pwsh: 'pwsh', csv: 'csv' };
const SEQ_BASE = { linux: 1, busybox: 0, bsd: 0 };

export const LANGS = {
  en: 'English', es: 'Español', pt: 'Português', ru: 'Русский', ja: '日本語', de: 'Deutsch', fr: 'Français',
};

const UNPARSED_CAP = 2000;
const NOTE_CAP = 2000;
const WIN_TIMEOUT_MS = 4000;     // ping.exe's default -w: a timed-out line took this long

/* ---- decoding -------------------------------------------------------------

   `ping > log.txt` in cmd writes the console's OEM code page, `>` in Windows
   PowerShell 5 writes UTF-16LE with a BOM, Notepad saves ANSI. A Spanish log
   read as UTF-8 comes out as "Estad�sticas", which no pattern matches. */

// IBM 850, 0x80–0xFF. Not in the WHATWG encoding list, so TextDecoder cannot
// do it — and it is what cmd writes on every Spanish and Portuguese system.
const CP850 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ';

function decodeCp850(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    const chunk = bytes.subarray(i, i + 8192);
    let s = '';
    for (let j = 0; j < chunk.length; j++) {
      const b = chunk[j];
      s += b < 0x80 ? String.fromCharCode(b) : CP850[b - 0x80];
    }
    out += s;
  }
  return out;
}

// Words that only decode correctly in the right code page.
const PROBE_WORDS = ['Estadísticas', 'Mínimo', 'Máximo', 'transmisión', 'Estatísticas', 'Média', 'inacessível',
  'Статистика', 'Ответ', 'Превышен', 'отправлено', 'получено', 'потеряно', 'Обмен', 'пакетами',
  '応答', '統計', 'タイムアウト', '送信', 'パケット', 'Réponse', 'Délai', 'données', 'Zeitüberschreitung', 'für'];

function scoreText(s) {
  let n = 0;
  for (const w of PROBE_WORDS) { let i = -1; while ((i = s.indexOf(w, i + 1)) !== -1) n += 4; }
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 0xFFFD) n -= 2;
  return n;
}

/** Which decoder a file needs, from its first bytes. `fallback` is the
    legacy code page to switch to if a BOM-less file turns out not to be
    valid UTF-8 somewhere past the head. */
export function sniffEncoding(head) {
  const b = head;
  if (b[0] === 0xFF && b[1] === 0xFE) return { name: 'UTF-16LE', label: 'utf-16le', skip: 2 };
  if (b[0] === 0xFE && b[1] === 0xFF) return { name: 'UTF-16BE', label: 'utf-16be', skip: 2 };
  if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return { name: 'UTF-8', label: 'utf-8', skip: 3 };
  // BOM-less UTF-16: ASCII text puts a zero in every other byte.
  const n = Math.min(b.length, 4096);
  let even = 0, odd = 0;
  for (let i = 0; i < n; i++) if (!b[i]) { if (i & 1) odd++; else even++; }
  if (n > 16 && odd > n / 4 && even < n / 50) return { name: 'UTF-16LE', label: 'utf-16le', skip: 0 };
  if (n > 16 && even > n / 4 && odd < n / 50) return { name: 'UTF-16BE', label: 'utf-16be', skip: 0 };
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b, { stream: true });
    return { name: 'UTF-8', label: 'utf-8', skip: 0, fatal: true, fallback: legacyPick(b) };
  } catch {
    return legacyPick(b);
  }
}

/** A legacy code page. Score each candidate on the head of the file by the
    localized words it decodes correctly, and keep the winner. */
function legacyPick(head) {
  const cands = [
    { name: 'CP850', custom: 'cp850' },
    { name: 'Windows-1252', label: 'windows-1252' },
    { name: 'CP866', label: 'ibm866' },
    { name: 'Windows-1251', label: 'windows-1251' },
    { name: 'Shift_JIS', label: 'shift_jis' },
  ];
  let best = cands[0], bestScore = -Infinity;
  for (const c of cands) {
    let s;
    try { s = scoreText(c.custom ? decodeCp850(head) : new TextDecoder(c.label).decode(head)); } catch { continue; }
    if (s > bestScore) { best = c; bestScore = s; }
  }
  return { ...best, skip: 0 };
}

function makeDecoder(enc) {
  if (enc.custom === 'cp850') return { decode: (b) => (b ? decodeCp850(b) : '') };
  return new TextDecoder(enc.label, { fatal: !!enc.fatal });
}

/** Decode a whole buffer to one string — small inputs and the tests. */
export function decode(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let enc = sniffEncoding(b.subarray(0, 262144));
  try {
    return { text: makeDecoder(enc).decode(b.subarray(enc.skip || 0)), encoding: enc.name };
  } catch {
    enc = enc.fallback;
    return { text: makeDecoder(enc).decode(b), encoding: enc.name };
  }
}

/* ---- the engine ----------------------------------------------------------------

   Owns the decoded text. It reads a File in a stream, decodes as it goes and
   cuts the text into line-aligned chunks of a few million characters; it then
   parses those chunks, and later answers for individual lines (the row
   tooltips) without the page ever holding the text. The worker runs one; when
   no worker can start, the page runs one itself. */

const CHUNK = 1 << 22;                         // ~4M characters per chunk

class Chunker {
  constructor() { this.chunks = []; this.firstLine = []; this.lines = 0; this.pending = []; this.size = 0; this.carry = ''; }

  add(piece) {
    if (!piece) return;
    this.pending.push(piece);
    this.size += piece.length;
    if (this.size >= CHUNK) this.flush(false);
  }

  flush(end) {
    let s = this.carry + this.pending.join('');
    this.pending = []; this.size = 0; this.carry = '';
    if (!end) {
      const cut = s.lastIndexOf('\n');
      // No newline in four million characters is not a ping log line, but it
      // must not grow without bound either: it becomes a chunk of its own.
      if (cut < 0 && s.length < CHUNK * 4) { this.carry = s; return; }
      if (cut >= 0) { this.carry = s.slice(cut + 1); s = s.slice(0, cut + 1); }
    }
    if (!s) return;
    this.firstLine.push(this.lines + 1);
    this.chunks.push(s);
    let p = -1;
    while ((p = s.indexOf('\n', p + 1)) !== -1) this.lines++;
    if (end && !s.endsWith('\n')) this.lines++;
  }
}

async function readDecode(file, enc, onProgress) {
  const reader = file.stream().getReader();
  const dec = makeDecoder(enc);
  const ch = new Chunker();
  let skip = enc.skip || 0, done = 0, tick = 0;
  try {
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      done += value.length;
      let v = value;
      if (skip) { const k = Math.min(skip, v.length); v = v.subarray(k); skip -= k; }
      ch.add(dec.decode(v, { stream: true }));
      if (onProgress && (++tick & 7) === 0) onProgress({ phase: 'read', done, total: file.size });
    }
    ch.add(dec.decode());
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err;
  }
  ch.flush(true);
  if (onProgress) onProgress({ phase: 'read', done: file.size, total: file.size });
  return { chunks: ch.chunks, firstLine: ch.firstLine, lines: ch.lines, encoding: enc.name };
}

function fromText(text) {
  const ch = new Chunker();
  for (let i = 0; i < text.length; i += CHUNK) ch.add(text.slice(i, i + CHUNK));
  ch.flush(true);
  return { chunks: ch.chunks, firstLine: ch.firstLine, lines: ch.lines, encoding: null };
}

export function createEngine() {
  let src = null;
  const offsets = new Map();        // chunk index -> line start offsets, built on demand

  return {
    async loadFile(file, onProgress) {
      const head = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
      const enc = sniffEncoding(head);
      try {
        src = await readDecode(file, enc, onProgress);
      } catch (err) {
        // Valid UTF-8 in the head, invalid further in: read it again as the
        // code page the head scored best for.
        if (!enc.fallback) throw err;
        src = await readDecode(file, enc.fallback, onProgress);
      }
      offsets.clear();
    },
    loadText(text) { src = fromText(text); offsets.clear(); },
    get encoding() { return src ? src.encoding : null; },
    parse(opts, onProgress) {
      const res = parseChunks(src.chunks, { ...opts, totalLines: src.lines, onProgress });
      res.encoding = src.encoding || opts.encoding || null;
      return res;
    },
    /** The text of the given (1-based) lines. */
    lines(nums) {
      if (!src) return nums.map(() => '');
      return nums.map((n) => {
        const fl = src.firstLine;
        let lo = 0, hi = fl.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fl[mid] <= n) lo = mid; else hi = mid - 1; }
        const c = src.chunks[lo];
        if (!c) return '';
        let off = offsets.get(lo);
        if (!off) {
          const list = [0];
          let p = -1;
          while ((p = c.indexOf('\n', p + 1)) !== -1) list.push(p + 1);
          off = Uint32Array.from(list);
          if (offsets.size > 8) offsets.delete(offsets.keys().next().value);
          offsets.set(lo, off);
        }
        const k = n - fl[lo];
        if (k < 0 || k >= off.length) return '';
        let e = k + 1 < off.length ? off[k + 1] - 1 : c.length;
        if (e > off[k] && c.charCodeAt(e - 1) === 13) e--;
        return c.slice(off[k], e);
      });
    },
  };
}

/* ---- timestamp prefixes ---------------------------------------------------- */

const SEP = String.raw`(?:\s*[-|>,]\s+|\s*:\s+|\s+)`;
const RX_EPOCH = /^\[(\d{9,11}(?:\.\d+)?)\]\s*/;
const RX_ISO = new RegExp(String.raw`^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?\s*(Z|[+-]\d{2}:?\d{2})?` + SEP);
const RX_NUM = new RegExp(String.raw`^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4}),?\s+(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d+))?(?:\s*(a\.?\s?m\.?|p\.?\s?m\.?|午前|午後))?` + SEP, 'i');
const RX_NAMED = new RegExp(String.raw`^(?:[A-Za-zÀ-ÿ]{2,4}\.?,?\s+)?(?:([A-Za-zÀ-ÿ]{3,4})\.?\s+(\d{1,2})|(\d{1,2})\s+(?:de\s+)?([A-Za-zÀ-ÿ]{3,4})\.?(?:\s+(?:de\s+)?(\d{4}))?),?\s+(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d+))?(?:\s*([AaPp])\.?\s?[Mm]\.?)?(?:\s+(?:[A-Z]{2,5}|[+-]\d{2}:?\d{2}))?(?:\s+(\d{4}))?` + SEP);
const RX_CLOCK = new RegExp(String.raw`^(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d+))?(?:\s*([ap])\.?\s?m\.?)?` + SEP, 'i');

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  ene: 0, abr: 3, ago: 7, dic: 11, fev: 1, mai: 4, set: 8, out: 9, dez: 11, sept: 8,
  janv: 0, févr: 1, mars: 2, avr: 3, juin: 5, juil: 6, août: 7, déc: 11, mär: 2, okt: 9, dez_: 11,
};

const frac = (s) => (s ? Number('0.' + s) * 1000 : 0);
function hour12(h, ap) {
  if (!ap) return h;
  const pm = /^p|午後/i.test(ap);
  if (h === 12) return pm ? 12 : 0;
  return pm ? h + 12 : h;
}

/** Numeric dates are ambiguous: 03/04 is March or April. A pre-pass looks for
    a field above 12 anywhere in the file; failing that, the language decides. */
function sniffDateOrder(lines, lang) {
  let dmy = 0, mdy = 0, ymd = 0, numeric = 0;
  // `lines` is already bounded: the head plus a sample from across the file.
  for (let i = 0; i < lines.length; i++) {
    const m = RX_NUM.exec(lines[i]);
    if (!m) continue;
    numeric++;
    if (m[1].length === 4) { ymd++; continue; }
    if (+m[1] > 12) dmy++;
    else if (+m[2] > 12) mdy++;
  }
  if (!numeric) return { order: lang === 'en' ? 'mdy' : 'dmy', ambiguous: false };
  if (ymd && !dmy && !mdy) return { order: 'ymd', ambiguous: false };
  if (dmy && !mdy) return { order: 'dmy', ambiguous: false };
  if (mdy && !dmy) return { order: 'mdy', ambiguous: false };
  return { order: lang === 'en' ? 'mdy' : 'dmy', ambiguous: true };
}

/** Strip a leading timestamp. Returns { abs } (epoch ms), { clock } (ms into
    the day — a time with no date) or null, plus the rest of the line. */
function stripStamp(line, ctx) {
  let m = RX_EPOCH.exec(line);
  if (m) return { abs: Number(m[1]) * 1000, rest: line.slice(m[0].length) };

  m = RX_ISO.exec(line);
  if (m) {
    const [, Y, M, D, h, mi, s, f, z] = m;
    let ms;
    if (z) {
      const off = z === 'Z' ? 0 : (z[0] === '-' ? -1 : 1) * (+z.slice(1, 3) * 60 + +z.slice(-2));
      ms = Date.UTC(+Y, +M - 1, +D, +h, +mi, +s) - off * 60000;
    } else {
      ms = new Date(+Y, +M - 1, +D, +h, +mi, +s).getTime();
    }
    return { abs: ms + frac(f), rest: line.slice(m[0].length) };
  }

  m = RX_NUM.exec(line);
  if (m) {
    let Y, M, D;
    const [, a, b, c, h, mi, s, f, ap] = m;
    if (a.length === 4) { Y = +a; M = +b; D = +c; }
    else if (ctx.dateOrder === 'mdy') { M = +a; D = +b; Y = +c; }
    else { D = +a; M = +b; Y = +c; }
    // The order was decided for the file; a field over 12 still overrules it
    // (and is all the detection pass has before that decision exists).
    if (M > 12 && D <= 12) [M, D] = [D, M];
    if (Y < 100) Y += 2000;
    if (M >= 1 && M <= 12 && D >= 1 && D <= 31) {
      const ms = new Date(Y, M - 1, D, hour12(+h, ap), +mi, +s).getTime() + frac(f);
      return { abs: ms, rest: line.slice(m[0].length) };
    }
  }

  m = RX_NAMED.exec(line);
  if (m) {
    const mon = (m[1] || m[4] || '').toLowerCase().replace('.', '');
    const M = MONTHS[mon] ?? MONTHS[mon.slice(0, 3)];
    if (M != null) {
      const D = +(m[2] || m[3]);
      let Y = +(m[5] || m[12] || 0);
      if (!Y) {
        // `ts` prints no year. Assume the reference year, stepping forward
        // when the month runs backwards (a log that crosses New Year).
        if (ctx.lastMonth != null && M < ctx.lastMonth - 6) ctx.yearBump++;
        Y = ctx.refYear + ctx.yearBump;
      }
      ctx.lastMonth = M;
      const ms = new Date(Y, M, D, hour12(+m[6], m[10]), +m[7], +m[8]).getTime() + frac(m[9]);
      return { abs: ms, rest: line.slice(m[0].length) };
    }
  }

  m = RX_CLOCK.exec(line);
  if (m) {
    const ms = ((hour12(+m[1], m[5]) * 60 + +m[2]) * 60 + +m[3]) * 1000 + frac(m[4]);
    return { clock: ms, rest: line.slice(m[0].length) };
  }
  return null;
}

/* A script that pings several hosts at once into one file has to say which
   line is whose, and the usual way is a bracketed tag:

     2026-09-24 10:01:16 [8.8.8.8] [1790265676.680296] 64 bytes from 8.8.8.8: …

   — a wrapper's date, the tag, then ping -D's own epoch. Prefixes are peeled
   in any order until none is left. When there are two clocks the epoch wins:
   it is ping's own, to the microsecond, where the wrapper's is to the second.
   A bracketed number is an epoch, never a tag; anything else bracketed at the
   start of a line is a tag — a host, an address, a label. */
const RX_TAG = /^\[([^\]\s]{1,253})\]\s*/;

function stripPrefixes(line, ctx) {
  let rest = line, abs = null, clock = null, tag = null, any = false;
  for (let k = 0; k < 4; k++) {
    const epoch = RX_EPOCH.test(rest);
    const st = stripStamp(rest, ctx);
    if (st) {
      if (st.abs != null && (abs == null || epoch)) abs = st.abs;
      else if (st.clock != null && abs == null) clock = st.clock;
      rest = st.rest; any = true;
      continue;
    }
    const m = tag == null ? RX_TAG.exec(rest) : null;
    if (m && !/^\d+(?:\.\d+)?$/.test(m[1])) { tag = m[1]; rest = rest.slice(m[0].length); any = true; continue; }
    break;
  }
  return any ? { abs, clock, tag, rest } : null;
}

/* ---- line patterns ---------------------------------------------------------- */

const IP = String.raw`(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,7}(?:%[\w.]+)?)`;
const RX_IP_ANY = new RegExp(IP);
const RX_IP_END = new RegExp(`(${IP})\\)?\\s*$`);

const num = (s) => (s == null ? null : Number(String(s).replace(',', '.')));
function unitMs(v, u) {
  if (v == null) return null;
  if (!u) return v;
  if (/^(s|sec)$/i.test(u)) return v * 1000;
  if (/^(us|µs|usec)$/i.test(u)) return v / 1000;
  return v;
}
function lastIp(s) {
  if (!s) return '';
  const m = RX_IP_END.exec(s.trim());
  return m ? m[1] : '';
}
function errKind(msg) {
  if (/time to live exceeded|ttl exceeded|time exceeded|ttl expired/i.test(msg)) return 'ttl';
  if (/unreachable|filtered|prohibited|host is down/i.test(msg)) return 'unreachable';
  return 'error';
}

// Unix family (iputils, BusyBox, BSD).
const U = {
  hdr: /^PING\s+(\S+?)\s*\((.+?)\)\s*:?\s*(?:from\s+\S+(?:\s+\S+:)?\s+)?(\d+)(\(\d+\))?\s*(?:data\s+)?bytes/,
  hdr6: /^PING6\(.*?\)\s+(\S+)\s+-->\s+(\S+)/,
  reply: /^(\d+)\s+bytes from\s+(.+?)[:,]\s+(icmp_seq|seq)=(\d+)(?:\s+(?:ttl|hlim)=(\d+))?(?:\s+time\s*([=<])\s*([\d.,]+)\s*(ms|msec|s|sec|µs|us|usec)?)?(.*)$/,
  noAnswer: /^no answer yet for icmp_seq=(\d+)/,
  from: /^From\s+(.+?)\s+(icmp_seq|seq)=(\d+)\s+(.+?)\s*$/,
  bsdTimeout: /^Request timeout for icmp_seq[= ](\d+)/,
  bsdErr: /^\d+\s+bytes from\s+(.+?):\s+(.+)$/,
  statsHdr: /^---\s+(.+?)\s+ping statistics\s+---/,
  tx: /(\d+)\s+packets transmitted/,
  rx: /(\d+)\s+(?:packets\s+)?received/,
  dup: /\+(\d+)\s+duplicates/,
  err: /\+(\d+)\s+errors/,
  rtt: /^(rtt|round-trip)\s+min\/avg\/max(?:\/(mdev|stddev))?\s*=\s*([\d.,]+)\/([\d.,]+)\/([\d.,]+)(?:\/([\d.,]+))?\s*(ms|s|µs|us)?/,
  noise: [
    /^ping:\s/i, /^ping6?:\s/i, /^connect:\s/i, /^PING:\s/,
    /^Vr\s+HL\s+TOS/, /^IP Hdr Dump/i, /^\s*\d\s+\d\s+[0-9a-f]{2}\s+[0-9a-f]{4}\s/i,
    /^\s*(?:[0-9a-f]{2,4}\s+){4,}[0-9a-f]{2,4}\s*$/i,
    /^Warning:/i, /^WARNING:/, /^\d+\/\d+ packets, \d+% loss/, /^PATTERN:/,
    /^\^[C\\]$/, /^\s*\^C/,
  ],
};

// Windows ping.exe, per language. Only headers and the fixed messages are
// worded; replies are matched by structure (see winReply).
const WIN = {
  en: {
    hdr: /^Pinging\s+(\S+)(?:\s+\[([^\]]+)\])?\s+(?:from\s+\S+\s+)?with\s+\d+/i,
    timeout: /^Request timed out\.?$/i,
    fail: /General failure|transmit failed/i,
    unreach: /unreachable/i,
    ttl: /TTL expired/i,
  },
  es: {
    hdr: /^Haciendo ping a\s+(\S+)(?:\s+\[([^\]]+)\])?\s+(?:desde\s+\S+\s+)?con\s+\d+/i,
    timeout: /^Tiempo de espera agotado/i,
    fail: /Error general|error de transmisi/i,
    unreach: /inaccesible/i,
    ttl: /TTL caduc/i,
  },
  pt: {
    hdr: /^Disparando\s+(\S+)(?:\s+\[([^\]]+)\])?\s+(?:de\s+\S+\s+)?com\s+\d+/i,
    timeout: /^Esgotado o tempo limite/i,
    fail: /Falha geral|falha na transmiss/i,
    unreach: /inacess[íi]vel/i,
    ttl: /TTL expirou/i,
  },
  ru: {
    hdr: /^Обмен пакетами с\s+(\S+)(?:\s+\[([^\]]+)\])?/i,
    timeout: /^Превышен интервал ожидания/i,
    fail: /Общий сбой|ошибка передачи/i,
    unreach: /недоступ/i,
    ttl: /срок жизни|TTL/i,
  },
  ja: {
    hdr: /^(\S+?)\s*(?:\[([^\]]+)\])?\s*に ping を送信しています/,
    timeout: /^要求がタイムアウトしました/,
    fail: /一般エラー|送信に失敗/,
    unreach: /到達できません/,
    ttl: /TTL が期限切れ/,
  },
  de: {
    hdr: /^Ping wird ausgeführt für\s+(\S+)(?:\s+\[([^\]]+)\])?/i,
    timeout: /^Zeitüberschreitung der Anforderung/i,
    fail: /Allgemeiner Fehler|Übertragung fehlgeschlagen/i,
    unreach: /nicht erreichbar/i,
    ttl: /TTL abgelaufen/i,
  },
  fr: {
    hdr: /^Envoi d['’]une requête ['‘]?ping['’]? sur\s+(\S+)(?:\s+\[([^\]]+)\])?/i,
    timeout: /^Délai d['’]attente de la demande dépassé/i,
    fail: /Défaillance générale|Échec de la transmission/i,
    unreach: /Impossible de joindre/i,
    ttl: /TTL expiré/i,
  },
};
const WIN_STATS = /(statisti|estad[íi]stica|estat[íi]stica|статистик|統計)/i;
const WIN_REPLY_HEAD = new RegExp(`^(?:[^\\d:：]{0,40}?\\s)?(${IP})(?:\\s[^:：=]{0,24})?\\s?[:：]\\s*(.*)$`);
const WIN_TIME = /([=<])\s*(\d+)\s*(?:ms|мсек|мс|m)(?![a-zа-я])/i;

/** A Windows reply in any language: an address, a colon, then either the
    numbers (bytes=, time=, TTL=) or a message (unreachable, TTL expired). */
function winReply(body) {
  const m = WIN_REPLY_HEAD.exec(body);
  if (!m) return null;
  const from = m[1];
  let rest = m[2];
  if (/^(?:\d+\s+bytes from|PING)/.test(body)) return null;
  const ttlM = /TTL\s*=\s*(\d+)/i.exec(rest);
  const ttl = ttlM ? +ttlM[1] : null;
  if (ttlM) rest = rest.replace(ttlM[0], '');
  const tm = WIN_TIME.exec(rest);
  if (tm) {
    const bm = /=\s*(\d+)\s/.exec(rest.slice(0, tm.index));
    // "time<1ms" is a bound, not a reading: ping.exe counts it as 0 in its own
    // summary. Half a millisecond is the honest midpoint; the row keeps the "<".
    const lt = tm[1] === '<';
    return { k: 'reply', from, rtt: lt ? Math.max(0, +tm[2] - 0.5) : +tm[2], lt, ttl, bytes: bm ? +bm[1] : null, winReply: true };
  }
  if (!rest.trim()) return null;
  let status = 'unreachable';
  for (const L of Object.values(WIN)) if (L.ttl.test(rest)) { status = 'ttl'; break; }
  return { k: 'lost', status, from, winReply: true };
}

// PowerShell Test-Connection.
const PS = {
  dest7: /^\s*Destination:\s*(\S+)\s*$/,
  head7: /^\s*Ping\s+Source\s+Address\s+Latency/i,
  head5: /^\s*Source\s+Destination\s+IPV4Address/i,
  rule: /^[\s-]+$/,
  units7: /^\s*\(ms\)\s+\(B\)\s*$/,
  row7: /^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\d+|\*)\s+(\d+|\*)\s+([A-Za-z]+)\s*$/,
  row5: /^\s*(\S+)\s+(\S+)\s+(\d{1,3}(?:\.\d{1,3}){3})?\s*((?:[0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F%]*)?\s+(\d+)\s+(\d+)\s*$/,
  fail5: /^Test-Connection\s*:.*?['‘’"](\S+?)['‘’"]/,
  psNoise: /^\s*(?:At line:|En línea:|Na linha:|\+\s|CategoryInfo|FullyQualifiedErrorId)/i,
};
function psStatus(s) {
  if (/^success$/i.test(s)) return 'ok';
  if (/timedout|timeout/i.test(s)) return 'timeout';
  if (/ttl|timeexceeded/i.test(s)) return 'ttl';
  if (/unreachable/i.test(s)) return 'unreachable';
  return 'error';
}

/**
 * Classify one line (timestamp already stripped). `fam` limits the families
 * tried, which is what a forced format means. Returns an event or null.
 */
function classify(body, fam, ctx) {
  const all = !fam;

  if (all || fam === 'unix') {
    let m = U.reply.exec(body);
    if (m) {
      const dup = /DUP!/.test(m[9] || '');
      return {
        k: 'reply', fam: 'unix', hint: m[3] === 'seq' ? 'busybox' : (/\(.+\)/.test(m[2]) ? 'linux' : null),
        bytes: +m[1], from: m[2], seq: +m[4], ttl: m[5] != null ? +m[5] : null,
        rtt: unitMs(num(m[7]), m[8]), lt: m[6] === '<', dup,
      };
    }
    if ((m = U.hdr.exec(body))) {
      return { k: 'hdr', fam: 'unix', hint: m[4] ? 'linux' : 'bsd', target: m[1], ip: lastIp(m[2]) || m[2] };
    }
    if ((m = U.hdr6.exec(body))) return { k: 'hdr', fam: 'unix', hint: 'bsd', target: m[2], ip: m[2] };
    if ((m = U.noAnswer.exec(body))) return { k: 'lost', fam: 'unix', hint: 'linux', status: 'timeout', seq: +m[1] };
    if ((m = U.bsdTimeout.exec(body))) return { k: 'lost', fam: 'unix', hint: 'bsd', status: 'timeout', seq: +m[1] };
    if ((m = U.from.exec(body))) {
      if (/redirect/i.test(m[4])) return { k: 'note', fam: 'unix' };
      return { k: 'lost', fam: 'unix', hint: m[2] === 'seq' ? 'busybox' : 'linux', status: errKind(m[4]), seq: +m[3], from: m[1] };
    }
    if ((m = U.statsHdr.exec(body))) return { k: 'stats', fam: 'unix', target: m[1] };
    if (U.tx.test(body) && U.rx.test(body)) {
      return {
        k: 'pkts', fam: 'unix', tx: +U.tx.exec(body)[1], rx: +U.rx.exec(body)[1],
        dup: U.dup.test(body) ? +U.dup.exec(body)[1] : 0,
        hint: /packets received/.test(body) ? 'bsd' : 'linux',
      };
    }
    if ((m = U.rtt.exec(body))) {
      const u = m[7];
      return {
        k: 'rtt', fam: 'unix', hint: m[1] === 'rtt' ? 'linux' : (m[2] ? 'bsd' : 'busybox'),
        min: unitMs(num(m[3]), u), avg: unitMs(num(m[4]), u), max: unitMs(num(m[5]), u),
        dev: m[6] != null ? unitMs(num(m[6]), u) : null,
      };
    }
    if ((m = U.bsdErr.exec(body)) && !/seq=/.test(body)) {
      return { k: 'lost', fam: 'unix', hint: 'bsd', status: errKind(m[2]), seq: null, from: m[1] };
    }
  }

  if (all || fam === 'windows') {
    for (const [lang, L] of Object.entries(WIN)) {
      const m = L.hdr.exec(body);
      if (m) return { k: 'hdr', fam: 'windows', lang, target: m[1], ip: m[2] || (RX_IP_ANY.test(m[1]) ? m[1] : '') };
    }
    if (/ping/i.test(body) && WIN_STATS.test(body) && /[:：]\s*$/.test(body)) {
      const ipm = RX_IP_ANY.exec(body);
      return { k: 'stats', fam: 'windows', target: ipm ? ipm[0] : '' };
    }
    if (ctx.inWinStats) {
      const eqs = [...body.matchAll(/=\s*(\d+)\s*(ms|мсек|мс)?/gi)];
      if (eqs.length === 3 && eqs.every((e) => e[2])) {
        return { k: 'rtt', fam: 'windows', min: +eqs[0][1], max: +eqs[1][1], avg: +eqs[2][1], dev: null };
      }
      if (eqs.length === 3 && eqs.every((e) => !e[2])) {
        return { k: 'pkts', fam: 'windows', tx: +eqs[0][1], rx: +eqs[1][1], lost: +eqs[2][1], dup: 0 };
      }
      return { k: 'note', fam: 'windows' };
    }
    for (const [lang, L] of Object.entries(WIN)) {
      if (L.timeout.test(body)) return { k: 'lost', fam: 'windows', lang, status: 'timeout' };
    }
    const r = winReply(body);
    if (r) {
      r.fam = 'windows';
      return r;
    }
    for (const [lang, L] of Object.entries(WIN)) {
      if (L.fail.test(body)) return { k: 'lost', fam: 'windows', lang, status: 'error' };
    }
    if (/^(?:Control-C|\^C)$/i.test(body.trim())) return { k: 'note', fam: 'windows' };
  }

  if (all || fam === 'pwsh') {
    let m = PS.dest7.exec(body);
    if (m) return { k: 'hdr', fam: 'pwsh', target: m[1], ip: RX_IP_ANY.test(m[1]) ? m[1] : '' };
    if (PS.head7.test(body)) { ctx.ps = 7; return { k: 'note', fam: 'pwsh' }; }
    if (PS.head5.test(body)) { ctx.ps = 5; return { k: 'note', fam: 'pwsh' }; }
    if (ctx.ps && (PS.rule.test(body) || PS.units7.test(body))) return { k: 'note', fam: 'pwsh' };
    if (ctx.ps === 7 && (m = PS.row7.exec(body))) {
      const status = psStatus(m[6]);
      return {
        k: status === 'ok' ? 'reply' : 'lost', fam: 'pwsh', status, seq: +m[1],
        from: m[3] === '*' ? '' : m[3], rtt: m[4] === '*' ? null : +m[4], bytes: m[5] === '*' ? null : +m[5], ttl: null,
      };
    }
    if (ctx.ps === 5 && (m = PS.row5.exec(body))) {
      return { k: 'reply', fam: 'pwsh', target: m[2], from: m[3] || m[4] || m[2], bytes: +m[5], rtt: +m[6], ttl: null };
    }
    if ((m = PS.fail5.exec(body))) return { k: 'lost', fam: 'pwsh', status: 'error', target: m[1] };
    if (ctx.ps && PS.psNoise.test(body)) return { k: 'note', fam: 'pwsh' };
  }

  if (all || fam === 'unix') {
    for (const rx of U.noise) if (rx.test(body)) return { k: 'note', fam: 'unix' };
  }
  return null;
}

/* ---- this tool's own CSV ------------------------------------------------- */

function splitCsv(line, d) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === d) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function isCsv(first) {
  return /^﻿?"?Seq"?[,;]/.test(first) && /Timestamp/.test(first) && /Status/.test(first);
}

const CSV_STATUS = {
  OK: 'ok', TIMEOUT: 'timeout', UNREACHABLE: 'unreachable', 'TTL EXCEEDED': 'ttl', ERROR: 'error', DUP: 'dup',
};

/* ---- storage ----------------------------------------------------------------

   One typed array per field, not one object per sample. An object costs well
   over a hundred bytes; these columns cost about 35 per sample, so a 6.5
   million-line log is ~230 MB instead of gigabytes — and typed arrays move to
   the page by transfer, with no copy. Missing numbers are NaN (seq, at, rtt)
   or -1 (ttl, bytes); responders are interned, `from` holds the index. */

export const STATUS = ['ok', 'timeout', 'unreachable', 'ttl', 'error', 'dup'];
const ST = { ok: 0, timeout: 1, unreachable: 2, ttl: 3, error: 4, dup: 5 };
export const F_INFERRED = 1, F_LT = 2, F_WINREPLY = 4, F_TAIL = 8, F_COLD = 16;
export const COLUMNS = ['line', 'sess', 'tgt', 'seq', 'at', 'rtt', 'ttl', 'bytes', 'from', 'status', 'flags'];

class Store {
  constructor() {
    this.n = 0;
    this.cap = 0;
    this.strings = [''];
    this.sidx = new Map([['', 0]]);
    this.grow(1 << 14);
  }

  grow(cap) {
    const re = (T, old) => { const a = new T(cap); if (old) a.set(old.subarray(0, this.n)); return a; };
    this.line = re(Uint32Array, this.line); this.sess = re(Uint32Array, this.sess); this.tgt = re(Uint16Array, this.tgt);
    this.seq = re(Float64Array, this.seq); this.at = re(Float64Array, this.at); this.clock = re(Float64Array, this.clock);
    this.rtt = re(Float64Array, this.rtt); this.ttl = re(Int16Array, this.ttl); this.bytes = re(Int32Array, this.bytes);
    this.from = re(Uint32Array, this.from); this.status = re(Uint8Array, this.status); this.flags = re(Uint8Array, this.flags);
    this.cap = cap;
  }

  str(s) {
    if (!s) return 0;
    let i = this.sidx.get(s);
    if (i == null) { i = this.strings.length; this.strings.push(s); this.sidx.set(s, i); }
    return i;
  }

  push(o) {
    if (this.n === this.cap) this.grow(this.cap * 2);
    const i = this.n++;
    this.write(i, o);
    return i;
  }

  write(i, o) {
    this.line[i] = o.line; this.sess[i] = o.sess; this.tgt[i] = o.tgt;
    this.seq[i] = o.seq ?? NaN; this.at[i] = o.at ?? NaN; this.clock[i] = o.clock ?? NaN;
    this.rtt[i] = o.rtt ?? NaN; this.ttl[i] = o.ttl ?? -1; this.bytes[i] = o.bytes ?? -1;
    this.from[i] = this.str(o.from); this.status[i] = ST[o.status];
    this.flags[i] = (o.inferred ? F_INFERRED : 0) | (o.lt ? F_LT : 0) | (o.winReply ? F_WINREPLY : 0)
      | (o.tail ? F_TAIL : 0) | (o.cold ? F_COLD : 0);
  }

  /** Trimmed copies, ready to transfer. */
  columns() {
    const cols = {};
    for (const k of COLUMNS) cols[k] = this[k].slice(0, this.n);
    return cols;
  }
}

/** The buffers to list in postMessage's transfer argument. */
export function transferables(res) {
  return res.cols ? COLUMNS.map((k) => res.cols[k].buffer) : [];
}

/** One sample as a plain object — for tests and the odd single-row read. */
export function sampleAt(res, i) {
  const c = res.cols;
  const nn = (v) => (v === v ? v : null);
  return {
    line: c.line[i], sess: c.sess[i], tgt: c.tgt[i], seq: nn(c.seq[i]), at: nn(c.at[i]), rtt: nn(c.rtt[i]),
    ttl: c.ttl[i] < 0 ? null : c.ttl[i], bytes: c.bytes[i] < 0 ? null : c.bytes[i], from: res.strings[c.from[i]],
    status: STATUS[c.status[i]], inferred: !!(c.flags[i] & F_INFERRED), lt: !!(c.flags[i] & F_LT),
    winReply: !!(c.flags[i] & F_WINREPLY), tail: !!(c.flags[i] & F_TAIL), cold: !!(c.flags[i] & F_COLD),
  };
}
export function toObjects(res) {
  const out = new Array(res.n);
  for (let i = 0; i < res.n; i++) out[i] = sampleAt(res, i);
  return out;
}

/* ---- lines, without one giant string --------------------------------------

   The text arrives as a list of chunks, each ending on a line boundary, so no
   string ever has to hold the whole file — Chrome caps a string at about 512
   million characters, which an 800 MB UTF-16 log alone would come close to,
   and splitting into an array of lines would copy it all a second time. */

function forEachLine(chunks, fn) {
  let n = 0;
  for (const c of chunks) {
    const L = c.length;
    let p = 0;
    while (p < L) {
      let e = c.indexOf('\n', p);
      if (e < 0) e = L;
      const end = e > p && c.charCodeAt(e - 1) === 13 ? e - 1 : e;
      fn(c.slice(p, end), ++n);
      p = e + 1;
    }
  }
  return n;
}

function headLines(chunks, max) {
  const out = [];
  for (const c of chunks) {
    let p = 0;
    while (p < c.length && out.length < max) {
      let e = c.indexOf('\n', p);
      if (e < 0) e = c.length;
      out.push(c.slice(p, e > p && c.charCodeAt(e - 1) === 13 ? e - 1 : e));
      p = e + 1;
    }
    if (out.length >= max) break;
  }
  return out;
}

/** The head plus a few lines from every part of the file. Deciding DD/MM vs
    MM/DD needs a day past the 12th, and on a long log the first 20 000
    lines can all fall on the 1st. */
function spread(chunks, head) {
  if (chunks.length < 2) return head;
  const out = head.slice();
  const every = Math.max(1, Math.floor(chunks.length / 64));
  for (let i = every; i < chunks.length; i += every) {
    const c = chunks[i];
    const at = c.indexOf('\n') + 1;              // skip a possibly partial first line
    out.push(...headLines([c.slice(at, at + 4000)], 20));
  }
  return out;
}

function countLines(chunks) {
  let n = 0;
  for (const c of chunks) { let p = -1; while ((p = c.indexOf('\n', p + 1)) !== -1) n++; }
  const last = chunks.length ? chunks[chunks.length - 1] : '';
  if (last && !last.endsWith('\n')) n++;
  return n;
}

/** Reads the CSV the live view and this view both export. */
function parseCsv(chunks, total, onProgress) {
  const store = new Store();
  const out = newResult('csv');
  const tIndex = new Map();
  const sIndex = new Map();
  let basis = null;
  let d = ',', c = null;
  forEachLine(chunks, (raw, lineNo) => {
    if (onProgress && !(lineNo & 0x3fff)) onProgress({ phase: 'parse', done: lineNo, total, rows: store.n });
    if (!c) {
      const first = raw.replace(/^﻿/, '');
      d = first.includes(';') && !first.includes(',') ? ';' : ',';
      const head = splitCsv(first, d).map((h) => h.trim());
      const col = (name) => head.indexOf(name);
      c = {
        seq: col('Seq'), ts: col('Timestamp'), basis: col('Time basis'), tgt: col('Target'), ip: col('Target IP'),
        from: col('Responder'), st: col('Status'), rtt: col('RTT (ms)'), ttl: col('TTL'), bytes: col('Bytes'),
        sess: col('Session'), phase: col('Phase'),
      };
      return;
    }
    if (!raw.trim()) return;
    const f = splitCsv(raw, d);
    const target = (f[c.tgt] || '').trim();
    const status = CSV_STATUS[(f[c.st] || '').trim().toUpperCase()];
    if (!target || !status) { pushCapped(out.unparsed, { line: lineNo, text: raw }, UNPARSED_CAP); out.unparsedCount++; return; }
    const key = target.toLowerCase();
    if (!tIndex.has(key)) {
      tIndex.set(key, out.targets.length);
      out.targets.push({ label: target, ip: c.ip >= 0 ? (f[c.ip] || '') : '' });
    }
    const tgt = tIndex.get(key);
    const sKey = `${c.sess >= 0 ? f[c.sess] : 1}|${key}`;
    if (!sIndex.has(sKey)) {
      sIndex.set(sKey, out.sessions.length);
      out.sessions.push(newSession(out.sessions.length, tgt, target, lineNo));
    }
    const sess = sIndex.get(sKey);
    const ts = (f[c.ts] || '').trim();
    const b = c.basis >= 0 ? (f[c.basis] || '').trim() : 'measured';
    let at = null, kind = 'absolute';
    let m;
    if ((m = /^\+(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(ts))) { at = ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + frac(m[4]); kind = 'estimated'; }
    else if ((m = /^D(\d+)\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(ts))) { at = (+m[1] - 1) * 86400000 + ((+m[2] * 60 + +m[3]) * 60 + +m[4]) * 1000 + frac(m[5]); kind = 'clock'; }
    else if (ts) { const v = Date.parse(ts); if (!Number.isNaN(v)) at = v; }
    if (/^estimated/.test(b)) kind = 'estimated';
    basis = basis || kind;
    const rtt = num((f[c.rtt] || '').trim() || null);
    store.push({
      line: lineNo, sess, tgt, seq: f[c.seq] ? +f[c.seq] : null, at, rtt: status === 'ok' || status === 'dup' ? rtt : null,
      ttl: c.ttl >= 0 && f[c.ttl] ? +f[c.ttl] : null, bytes: c.bytes >= 0 && f[c.bytes] ? +f[c.bytes] : null,
      from: c.from >= 0 ? (f[c.from] || '') : '', status, inferred: /inferred/.test(b),
      cold: c.phase >= 0 && /^cold/.test(f[c.phase] || ''),
    });
    if (status === 'dup') out.dups++;
    else out.sessions[sess].n++;
  });
  out.basis = basis || 'absolute';
  return { out, store };
}

/* ---- the parse ------------------------------------------------------------ */

function pushCapped(arr, v, cap) { if (arr.length < cap) arr.push(v); }

function newResult(format) {
  return {
    format, lang: null, encoding: null, basis: 'estimated', dateOrder: null, dateAmbiguous: false,
    interval: 1000, targets: [], sessions: [], n: 0, cols: null, strings: [''], dups: 0,
    notes: [], noteCount: 0, unparsed: [], unparsedCount: 0, lineCount: 0,
  };
}
function newSession(id, tgt, label, line) {
  return { id, tgt, label, ip: '', startLine: line, endLine: line, n: 0, hadHeader: false, summary: null, check: null };
}

/**
 * Should wrapped lines be re-joined? In a log whose lines open with a
 * timestamp or tag, a line that has neither and means nothing on its own
 * ("ttl=58 time=30.2 ms", "ms") is the tail of the line before it. Prefixed
 * lines are counted against such fragments in the head of the file; wrapping
 * one line into three makes two fragments per prefix, so the bound is
 * generous, and a log with no prefixes at all is never touched.
 */
function wantsUnwrap(head) {
  const ctx = { dateOrder: 'dmy', refYear: 2000, yearBump: 0, lastMonth: null, inWinStats: false, ps: 0 };
  let n = 0, pre = 0, frag = 0;
  for (const l of head) {
    if (!l.trim()) continue;
    if (++n > 2000) break;
    if (stripPrefixes(l, ctx)) pre++;
    else if (!classify(l.trim(), null, ctx)) frag++;
  }
  return pre >= 3 && frag > 0 && frag <= pre * 4;
}

/** Physical lines to logical ones: fragments are appended to the line they
    belong to, which keeps its own (first) line number. */
function logicalLines(chunks, unwrap, fn) {
  if (!unwrap) return forEachLine(chunks, fn);
  const ctx = { dateOrder: 'dmy', refYear: 2000, yearBump: 0, lastMonth: null, inWinStats: false, ps: 0 };
  let held = null, heldNo = 0;
  const n = forEachLine(chunks, (l, no) => {
    if (!l.trim()) return;
    if (held != null && !stripPrefixes(l, ctx) && !classify(l.trim(), null, ctx)) {
      held = held.replace(/\s+$/, '') + ' ' + l.trim();
      return;
    }
    if (held != null) fn(held, heldNo);
    held = l; heldNo = no;
  });
  if (held != null) fn(held, heldNo);
  return n;
}

/** Score the head of the file and pick a format (and, for Windows, a language). */
export function detect(lines) {
  const firstReal = lines.find((l) => l.trim());
  if (firstReal && isCsv(firstReal)) return { format: 'csv', lang: null, confidence: 1 };
  const votes = { linux: 0, busybox: 0, bsd: 0, windows: 0, pwsh: 0 };
  const langs = {};
  const ctx = { dateOrder: 'dmy', refYear: 2000, yearBump: 0, lastMonth: null, inWinStats: false, ps: 0 };
  let seen = 0, hit = 0;
  for (let i = 0; i < lines.length && seen < 400; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line.trim()) continue;
    seen++;
    const st = stripPrefixes(line, ctx);
    const body = (st ? st.rest : line).trim();
    const ev = classify(body, null, ctx);
    if (!ev) continue;
    hit++;
    if (ev.k === 'stats' && ev.fam === 'windows') ctx.inWinStats = true;
    else if (ev.k === 'hdr') ctx.inWinStats = false;
    if (ev.fam === 'unix') {
      if (ev.hint) votes[ev.hint] += ev.k === 'hdr' || ev.k === 'rtt' || ev.k === 'pkts' ? 3 : 1;
      else votes.linux += 0.5;
    } else if (ev.fam === 'windows') {
      votes.windows += 1;
      if (ev.lang) langs[ev.lang] = (langs[ev.lang] || 0) + 1;
    } else if (ev.fam === 'pwsh') votes.pwsh += 1;
  }
  const [format, score] = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  if (!score) return { format: null, lang: null, confidence: 0 };
  const lang = format === 'windows'
    ? (Object.entries(langs).sort((a, b) => b[1] - a[1])[0] || ['en'])[0]
    : null;
  return { format, lang, confidence: seen ? hit / seen : 0 };
}

/** Parse a log held in one string (tests, pasted text). */
export function parseLog(text, opts = {}) {
  return parseChunks([text], opts);
}

// Sequence numbers remembered per session for late replies and duplicates.
// A 16-bit counter cannot tell more apart than this anyway.
const SEQ_RING = 65536;

/**
 * Parse a whole log.
 * @param chunks decoded text, as strings that each end on a line boundary
 * @param opts   { format?: forced format, interval?: ms per probe when the
 *                 log has no clock, dateOrder?: 'dmy'|'mdy'|'ymd', refYear?,
 *                 totalLines?, onProgress?: ({ phase, done, total, rows }) =>
 *                 void — called every 16 384 lines }
 */
export function parseChunks(chunks, opts = {}) {
  const total = opts.totalLines || countLines(chunks);
  const head = headLines(chunks, 20000);
  const det = detect(head);
  const format = opts.format || det.format;
  const onProgress = opts.onProgress;
  if (!format) {
    const r = newResult(null);
    r.lineCount = total;
    return r;
  }
  if (format === 'csv') {
    const { out, store } = parseCsv(chunks, total, onProgress);
    out.lineCount = total;
    seal(out, store, opts);
    return out;
  }

  const fam = opts.format ? FAMILY[format] : null;
  const lang = det.lang || 'en';
  const order = opts.dateOrder ? { order: opts.dateOrder, ambiguous: false } : sniffDateOrder(spread(chunks, head), lang);

  const out = newResult(format);
  const store = new Store();
  out.lang = format === 'windows' ? lang : null;
  out.lineCount = total;
  out.dateOrder = order.order;
  out.dateAmbiguous = order.ambiguous;
  out.interval = opts.interval || 1000;

  const ctx = {
    dateOrder: order.order, refYear: opts.refYear || new Date().getFullYear(), yearBump: 0, lastMonth: null,
    inWinStats: false, ps: 0,
  };
  const tIndex = new Map();
  let stamped = { abs: 0, clock: 0 };
  let clockDay = 0, lastClock = null;

  // One stream per tag. An untagged log is a single stream (''); a tagged one
  // interleaves several pings line by line, and each keeps its own session
  // and its own sequence numbers — 8.8.8.8's seq 4 says nothing about 1.1.1.1's.
  const streams = new Map();
  let key = '';
  let cur = null;        // the session being filled, in the current stream
  let seqState = null;   // its sequence bookkeeping

  const targetFor = (label, ip) => {
    const k = String(label).toLowerCase();
    if (!tIndex.has(k)) { tIndex.set(k, out.targets.length); out.targets.push({ label, ip: ip || '' }); }
    const i = tIndex.get(k);
    if (ip && !out.targets[i].ip) out.targets[i].ip = ip;
    return i;
  };

  const closeSession = () => {
    if (!cur) return;
    if (seqState && cur.summary && cur.summary.tx != null) {
      // Packets lost after the last reply print nothing; the summary's
      // transmitted count is the only evidence they were ever sent.
      const missing = cur.summary.tx - cur.n;
      for (let k = 0; k < missing; k++) {
        pushSample({ line: cur.endLine, seq: seqState.next != null ? seqState.next++ : null, status: 'timeout', inferred: true, tail: true });
      }
    }
    cur = null;
    seqState = null;
  };

  const openSession = (label, ip, line, header) => {
    closeSession();
    const tgt = targetFor(label, ip);
    cur = newSession(out.sessions.length, tgt, label, line);
    cur.ip = ip || '';
    cur.hadHeader = header;
    cur.stream = key;
    out.sessions.push(cur);
    seqState = FAMILY[format] === 'unix' || format === 'pwsh'
      ? {
        next: header && SEQ_BASE[format] != null ? SEQ_BASE[format] : null, wrap: 0,
        // A ring of the last SEQ_RING sequence numbers and where each went,
        // in place of a map that would hold one entry per packet ever sent.
        ringSeq: new Float64Array(SEQ_RING).fill(NaN), ringIdx: new Uint32Array(SEQ_RING),
      }
      : null;
  };

  function pushSample(s) {
    const i = store.push({ ...s, sess: cur.id, tgt: cur.tgt });
    if (s.status !== 'dup') cur.n++;
    if (s.line > cur.endLine) cur.endLine = s.line;
    return i;
  }

  const remember = (st, seq, idx) => { const r = seq & (SEQ_RING - 1); st.ringSeq[r] = seq; st.ringIdx[r] = idx; };
  const recall = (st, seq) => { const r = seq & (SEQ_RING - 1); return st.ringSeq[r] === seq ? st.ringIdx[r] : -1; };

  /** Place an event that carries a sequence number, inferring the gap before it. */
  function placeSeq(ev, line, stamp) {
    const st = seqState;
    let u = ev.seq + st.wrap;
    if (st.next != null && u < st.next - 30000) { st.wrap += 65536; u += 65536; }   // 16-bit wrap
    const base = { line, rtt: ev.rtt, ttl: ev.ttl, bytes: ev.bytes, from: ev.from, lt: ev.lt, ...stamp };
    if (st.next == null) st.next = u;
    if (u >= st.next) {
      const gap = u - st.next;
      if (gap > 65535) st.next = u;        // a restart without a header, not an outage
      for (let s = st.next; s < u; s++) remember(st, s, pushSample({ line, seq: s, status: 'timeout', inferred: true }));
      remember(st, u, pushSample({ ...base, seq: u, status: ev.status }));
      st.next = u + 1;
      return;
    }
    // Earlier than expected: a late reply, a duplicate, or the explicit verdict
    // on a packet already inferred lost.
    const idx = recall(st, u);
    if (idx < 0) {
      const status = ev.status === 'ok' ? 'dup' : ev.status;
      if (status === 'dup') out.dups++;
      pushSample({ ...base, seq: u, status });
      return;
    }
    if (store.status[idx] === ST.ok) {
      if (ev.status === 'ok') { pushSample({ ...base, seq: u, status: 'dup' }); out.dups++; }
      return;
    }
    // Replace the placeholder (or an explicit timeout answered late) in place.
    const prevAt = store.at[idx], prevClock = store.clock[idx];
    store.write(idx, {
      line, sess: store.sess[idx], tgt: store.tgt[idx], seq: u, rtt: ev.rtt, ttl: ev.ttl, bytes: ev.bytes,
      from: ev.from, status: ev.status, lt: ev.lt,
      at: stamp.at ?? (prevAt === prevAt ? prevAt : null), clock: stamp.clock ?? (prevClock === prevClock ? prevClock : null),
    });
  }

  logicalLines(chunks, wantsUnwrap(head), (raw, lineNo) => {
    if (onProgress && !(lineNo & 0x3fff)) onProgress({ phase: 'parse', done: lineNo, total, rows: store.n });
    if (!raw.trim()) return;
    const st = stripPrefixes(raw, ctx);
    const body = (st ? st.rest : raw).trim();
    // A wrapper stamps every line ping prints, the blank ones included:
    // "01/09/2026 08:00:00 - " is an empty line, not an unreadable one.
    if (!body) return;
    const nextKey = st && st.tag ? st.tag : '';
    if (nextKey !== key) {
      streams.set(key, { cur, seqState });
      key = nextKey;
      ({ cur = null, seqState = null } = streams.get(key) || {});
    }
    const stamp = {};
    if (st && st.abs != null) { stamp.at = st.abs; }
    else if (st && st.clock != null) {
      if (lastClock != null && st.clock < lastClock - 3600000) clockDay++;
      lastClock = st.clock;
      stamp.clock = clockDay * 86400000 + st.clock;
    }

    const ev = classify(body, fam, ctx);
    if (!ev) {
      out.unparsedCount++;
      pushCapped(out.unparsed, { line: lineNo, text: raw }, UNPARSED_CAP);
      return;
    }
    if (ev.k === 'note') {
      out.noteCount++;
      pushCapped(out.notes, { line: lineNo, text: raw }, NOTE_CAP);
      if (cur) cur.endLine = lineNo;
      return;
    }

    if (ev.k === 'hdr') {
      ctx.inWinStats = false;
      openSession(ev.target, ev.ip, lineNo, true);
      return;
    }
    if (ev.k === 'stats') {
      if (ev.fam === 'windows') ctx.inWinStats = true;
      if (!cur) openSession(ev.target || 'unknown', lastIp(ev.target), lineNo, false);
      cur.summary = cur.summary || {};
      cur.endLine = lineNo;
      return;
    }
    if (ev.k === 'pkts' || ev.k === 'rtt') {
      if (!cur) return;
      cur.summary = cur.summary || {};
      if (ev.k === 'pkts') Object.assign(cur.summary, { tx: ev.tx, rx: ev.rx, dupReported: ev.dup || 0 });
      else Object.assign(cur.summary, { min: ev.min, avg: ev.avg, max: ev.max, dev: ev.dev });
      cur.endLine = lineNo;
      return;
    }

    // A sample. Lines before any header open an implicit session named after
    // whoever answered; PowerShell 5 names the destination on every row.
    ctx.inWinStats = false;
    const status = ev.k === 'reply' ? (ev.dup ? 'dup' : 'ok') : ev.status;
    // With no header to name the session, a tag is a better name than the
    // responder: it is what the person who wrote the script called the target.
    const label = ev.target || key || ev.from || 'unknown';
    if (!cur || (ev.target && cur.label.toLowerCase() !== String(ev.target).toLowerCase())) {
      openSession(lastIp(label) && ev.target == null && !key ? lastIp(label) : label, lastIp(ev.from || ''), lineNo, false);
    }
    if (st && st.abs != null) stamped.abs++; else if (st && st.clock != null) stamped.clock++;

    if (status === 'dup' && ev.seq == null) { pushSample({ line: lineNo, ...ev, status: 'dup', ...stamp }); out.dups++; return; }
    if (status === 'dup') { pushSample({ line: lineNo, ...ev, seq: ev.seq + seqState.wrap, status: 'dup', ...stamp }); out.dups++; return; }

    if (seqState) {
      if (ev.seq == null) {
        // BSD prints "Destination Host Unreachable" without a sequence number:
        // pin it to the next one so a later reply does not count it twice.
        if (seqState.next == null) { pushSample({ line: lineNo, ...ev, seq: cur.n + 1, status, ...stamp }); return; }
        ev.seq = seqState.next - seqState.wrap;
      }
      placeSeq({ ...ev, status }, lineNo, stamp);
    } else {
      pushSample({ line: lineNo, ...ev, seq: cur.n + 1, status, ...stamp });
    }
  });
  streams.set(key, { cur, seqState });
  for (const [k, sv] of streams) { key = k; cur = sv.cur; seqState = sv.seqState; closeSession(); }

  let real = 0;
  for (let i = 0; i < store.n; i++) if (!(store.flags[i] & F_INFERRED)) real++;
  real = real || 1;
  out.basis = stamped.abs / real >= 0.5 ? 'absolute' : stamped.clock / real >= 0.5 ? 'clock' : 'estimated';
  seal(out, store, opts);
  return out;
}

/** Order the samples by session in one pass (a counting sort): what the time
    axis and the summary checks both need, without a filter per session. */
function bySession(store, ns) {
  const start = new Uint32Array(ns + 1);
  for (let i = 0; i < store.n; i++) start[store.sess[i] + 1]++;
  for (let s = 0; s < ns; s++) start[s + 1] += start[s];
  const pos = start.slice(0, ns);
  const order = new Uint32Array(store.n);
  for (let i = 0; i < store.n; i++) order[pos[store.sess[i]]++] = i;
  return { start, order };
}

/** Compare every session against the summary ping printed for it — one pass
    over the samples for all of them. */
function checkAll(out, store) {
  const ns = out.sessions.length;
  const tx = new Uint32Array(ns), rx = new Uint32Array(ns), cnt = new Uint32Array(ns), tail = new Uint32Array(ns);
  const lo = new Float64Array(ns).fill(Infinity), hi = new Float64Array(ns).fill(-Infinity), sum = new Float64Array(ns);
  const win = out.format === 'windows';
  for (let i = 0; i < store.n; i++) {
    const st = store.status[i];
    if (st === ST.dup) continue;
    const s = store.sess[i];
    tx[s]++;
    // ping.exe counts "Destination host unreachable" as received — it was a
    // reply, just not from the target. This tool counts it as lost, so the
    // comparison has to count it the Windows way to be fair.
    if (st === ST.ok || (win && (store.flags[i] & F_WINREPLY))) rx[s]++;
    const v = store.rtt[i];
    if (st === ST.ok && v === v) { cnt[s]++; sum[s] += v; if (v < lo[s]) lo[s] = v; if (v > hi[s]) hi[s] = v; }
    if (store.flags[i] & F_TAIL) tail[s]++;
  }
  const tol = (v) => Math.max(win ? 1 : 0.06, Math.abs(v) * 0.006);
  for (const sess of out.sessions) {
    const sm = sess.summary;
    if (!sm || sm.tx == null) continue;
    const s = sess.id;
    const issues = [];
    if (tx[s] !== sm.tx) issues.push({ what: 'sent', ping: sm.tx, ours: tx[s] });
    if (rx[s] !== sm.rx) issues.push({ what: 'received', ping: sm.rx, ours: rx[s] });
    if (sm.min != null && cnt[s]) {
      if (Math.abs(lo[s] - sm.min) > tol(sm.min)) issues.push({ what: 'min', ping: sm.min, ours: lo[s] });
      if (Math.abs(hi[s] - sm.max) > tol(sm.max)) issues.push({ what: 'max', ping: sm.max, ours: hi[s] });
      const avg = sum[s] / cnt[s];
      if (Math.abs(avg - sm.avg) > tol(sm.avg) + 0.5) issues.push({ what: 'avg', ping: sm.avg, ours: avg });
    }
    sess.check = { ok: !issues.length, issues, tail: tail[s], dev: sm.dev ?? null };
  }
}

/** Put every sample on one time axis, whatever the log gave us, check the
    summaries, and hand the columns over. Linear in the number of samples. */
function seal(out, store, opts) {
  const interval = opts.interval || out.interval || 1000;
  out.interval = interval;
  const ns = out.sessions.length;
  const { start, order } = bySession(store, ns);
  const { at, seq, clock, status } = store;

  if (out.basis === 'clock' && out.format !== 'csv') at.set(clock.subarray(0, store.n));

  if (out.basis === 'estimated') {
    // No clock: lay the sessions end to end, one interval per probe. Sequence
    // numbers place samples exactly within a run, gaps included; Windows has
    // none, so a timed-out line is charged the full timeout it waited.
    // Interleaved streams ran at the same time, so each has its own cursor.
    const cursors = new Map();
    for (const sess of out.sessions) {
      const cursor = cursors.get(sess.stream || '') || 0;
      const a = start[sess.id], b = start[sess.id + 1];
      if (out.format === 'csv') { for (let q = a; q < b; q++) if (at[order[q]] !== at[order[q]]) at[order[q]] = cursor; continue; }
      let seqd = b > a && FAMILY[out.format] !== 'windows', first = Infinity;
      for (let q = a; q < b && seqd; q++) { const v = seq[order[q]]; if (v !== v) seqd = false; else if (v < first) first = v; }
      let t = cursor, last = cursor;
      for (let q = a; q < b; q++) {
        const i = order[q];
        if (seqd) at[i] = cursor + (seq[i] - first) * interval;
        else {
          at[i] = t;
          if (status[i] !== ST.dup) t += status[i] === ST.timeout && out.format === 'windows' ? Math.max(interval, WIN_TIMEOUT_MS) : interval;
        }
        if (at[i] > last) last = at[i];
      }
      cursors.set(sess.stream || '', last + interval);
    }
  } else {
    // A clock exists, but inferred samples (and the odd unstamped line) have
    // none: interpolate each run of them between its stamped neighbours, by
    // sequence number where both ends have one. One pass per session — the
    // first version rescanned the run for every sample in it, which is
    // quadratic in the length of an outage.
    for (let s = 0; s < ns; s++) {
      const a = start[s], b = start[s + 1];
      let known = -1;                         // position (in order) of the last stamped sample
      const fill = (ka, kb) => {
        const A = ka >= a ? order[ka] : -1, B = kb < b ? order[kb] : -1;
        for (let q = ka + 1; q < kb; q++) {
          const i = order[q];
          const sA = A >= 0 ? seq[A] : NaN, sB = B >= 0 ? seq[B] : NaN, si = seq[i];
          if (A >= 0 && B >= 0 && sA === sA && sB === sB && si === si && sB !== sA) at[i] = at[A] + ((si - sA) / (sB - sA)) * (at[B] - at[A]);
          else if (A >= 0) at[i] = at[A] + (si === si && sA === sA ? si - sA : q - ka) * interval;
          else if (B >= 0) at[i] = at[B] - (si === si && sB === sB ? sB - si : kb - q) * interval;
        }
      };
      for (let q = a; q < b; q++) {
        if (at[order[q]] !== at[order[q]]) continue;
        if (q - 1 > known && (known >= a || q > a)) fill(known >= a ? known : a - 1, q);
        known = q;
      }
      if (known >= a && known < b - 1) fill(known, b);
    }
    for (let i = 0; i < store.n; i++) if (at[i] !== at[i]) at[i] = 0;
  }

  checkAll(out, store);
  for (const sess of out.sessions) {
    const tg = out.targets[sess.tgt];
    if (tg && !tg.ip && sess.ip) tg.ip = sess.ip;
  }
  out.n = store.n;
  out.cols = store.columns();
  out.strings = store.strings;
}
