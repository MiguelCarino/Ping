/* client.js — who and what took the measurement.

   A latency report with no idea where it was taken from is an anecdote. When
   three sites send back readings for the same target, the thing that makes them
   comparable is knowing which machine, which browser and which connection each
   one came from.

   The identifier is generated here, in the browser, and never leaves it except
   inside a report the user exports themselves. It is a random value — not a
   fingerprint, not derived from hardware, not stable across browsers or
   profiles, and clearable by clearing site data. Its whole job is to let one
   person say "these four reports are from the same laptop".

   What this file will NOT tell you is the network interface. There is no web
   API for it, and that is deliberate rather than an oversight: Chrome and
   Firefox replace WebRTC host candidates with a random `<uuid>.local` mDNS name
   precisely so a page cannot enumerate the local network. `navigator.connection.type`
   is the nearest thing, and only Chromium on Android and ChromeOS actually
   populates it — on desktop it is undefined, and Firefox and Safari do not ship
   the API at all. Everything here reports "not published" rather than guessing. */

const KEY = 'carino-ping/client';

/** Stable-per-browser random id, e.g. "CP-4F2A-91C7". */
export function clientId() {
  let id = null;
  try { id = localStorage.getItem(KEY); } catch { /* private mode */ }
  if (id) return id;
  const rnd = new Uint8Array(4);
  (crypto.getRandomValues ? crypto : { getRandomValues: (a) => a.forEach((_, i) => { a[i] = Math.floor(Math.random() * 256); }) })
    .getRandomValues(rnd);
  const hex = Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  id = `CP-${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
  try { localStorage.setItem(KEY, id); } catch { /* not fatal, id is per-session then */ }
  return id;
}

/** Best-effort platform name from UA-CH, falling back to the UA string. */
function platform() {
  const ua = navigator.userAgentData;
  if (ua && ua.platform) return ua.platform;
  const s = navigator.userAgent;
  if (/Windows NT/.test(s)) return 'Windows';
  if (/Mac OS X/.test(s)) return 'macOS';
  if (/Android/.test(s)) return 'Android';
  if (/(iPhone|iPad|iPod)/.test(s)) return 'iOS';
  if (/Linux/.test(s)) return 'Linux';
  return 'Unknown';
}

/** Browser name and major version, from UA-CH brands where available. */
function browser() {
  const ua = navigator.userAgentData;
  if (ua && Array.isArray(ua.brands)) {
    // Skip the deliberate padding entry. Its exact spelling is intentionally
    // random per browser build — "Not)A;Brand", "Not_A Brand", "Not.A/Brand" —
    // so the match has to ignore whatever punctuation it was given this time.
    const real = ua.brands.filter((b) => !/not.{0,2}a.{0,2}brand/i.test(b.brand));
    const pick = real.find((b) => !/Chromium/i.test(b.brand)) || real[0];
    if (pick) return `${pick.brand} ${pick.version}`;
  }
  const s = navigator.userAgent;
  const m = s.match(/(Firefox|Edg|OPR|Chrome|Safari)\/(\d+)/);
  if (!m) return 'Unknown';
  const name = { Edg: 'Edge', OPR: 'Opera' }[m[1]] || m[1];
  return `${name} ${m[2]}`;
}

/**
 * Connection facts the browser is willing to publish. Every field is either a
 * real value or null — nothing here is inferred.
 */
export function connection() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  return {
    // 'wifi' | 'cellular' | 'ethernet' | 'none' | … — Chromium on Android and
    // ChromeOS only. Undefined everywhere else, which is why it is surfaced as
    // "not published" rather than guessed at from the effective type.
    type: (c && c.type) || null,
    effectiveType: (c && c.effectiveType) || null,
    downlinkHint: (c && typeof c.downlink === 'number') ? c.downlink : null,
    rttHint: (c && typeof c.rtt === 'number') ? c.rtt : null,
    saveData: c ? !!c.saveData : null,
    supported: !!c,
  };
}

export function environment() {
  const nav = navigator;
  return {
    id: clientId(),
    browser: browser(),
    platform: platform(),
    languages: (nav.languages && nav.languages.slice(0, 3).join(', ')) || nav.language || '',
    timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone) || '',
    utcOffsetMin: -new Date().getTimezoneOffset(),
    screen: `${screen.width}x${screen.height}`,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    dpr: window.devicePixelRatio || 1,
    cores: nav.hardwareConcurrency || null,
    memoryGB: nav.deviceMemory || null,
    online: nav.onLine,
    connection: connection(),
  };
}

/** One-line human summary for the status strip. */
export function connectionLabel(conn, t = (x) => x) {
  if (!conn.supported) return t('not published by this browser');
  const bits = [];
  if (conn.type) bits.push(conn.type);
  if (conn.effectiveType) bits.push(conn.effectiveType);
  if (conn.rttHint != null) bits.push(`~${conn.rttHint} ms`);
  return bits.length ? bits.join(' · ') : t('not published by this browser');
}
