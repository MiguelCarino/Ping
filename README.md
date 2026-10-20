# Ping

Client-side network latency measurement and ping log analysis — part of [Carino Systems](https://carino.systems). Live at **ping.carino.systems**.

Two modes on one page. **Live** measures round trip, jitter, packet loss and the DNS/TCP/TLS/TTFB split for any set of websites, from your own browser. **Log file** (`#log`) reads output the `ping` command already wrote — on Linux, a router, a Mac or Windows — and analyzes it: detection, a filterable table, charts, the same statistics, exports and report. Nothing is uploaded in either mode; the only traffic is the live probes themselves, going to the hosts you name.

## What it measures, and what it cannot

**A browser cannot send ICMP.** No web API exposes raw sockets, so the `ping` command's actual protocol is unavailable to any web page — and a page claiming otherwise is timing something else. What this does instead:

- **HTTPS round trip.** One `fetch` per probe, `mode: 'no-cors'`, cache and credentials off, aborted at the timeout via `AbortController`. An opaque response means the host answered; a rejection means it did not. That distinction is the measurement.
- **The phase split, where the server permits it.** If a target sends `Timing-Allow-Origin`, the Resource Timing API exposes DNS, TCP, TLS, TTFB and transfer separately, and the headline number becomes **time-to-first-byte** — mostly propagation delay, and the closest thing a browser has to an ICMP RTT. Without that header only the total is visible, which still contains server processing and transfer time. Every card and row says which one it got.
- **Cold vs warm.** The first request to a host pays DNS plus both handshakes — routinely three to five times the steady-state round trip. **Drop the first request** is on by default: it is still sent, because something has to open the connection, and then it is not recorded at all — no sample row, no card footnote, no export line, and it is not counted in Sent. Turn it off to see what the handshake cost: the sample comes back flagged *cold*, and it stays out of every statistic either way.
- **STUN baseline.** A STUN binding exchange is UDP with no TLS and no server-side work, so the time to the first server-reflexive candidate is very nearly the raw network round trip to the public internet. It is the floor to compare HTTP readings against: the gap is everything the protocol stack adds on top of distance.

The Resource Timing entry is **not** available the moment `await fetch()` resolves — it lands a beat later, so the probe waits for it through a `PerformanceObserver` with a short grace period. Reading it synchronously is the obvious way to write this and silently downgrades every target to *total only*.

Statistics are **min / p50 / p95 / max, jitter (RFC 3550 mean absolute successive difference) and loss** — not a running mean. Queueing delay is one-sided, so a mean is dragged permanently by a single outlier while the minimum stays the best estimate of the actual path.

**An IP address is not an ICMP ping.** A few answer — `8.8.8.8`, `1.1.1.1` and `9.9.9.9` serve HTTPS with certificates valid for the address, so they return a real number, but it is their web server's round trip rather than the address's reachability. Most other addresses have no HTTPS listener or no certificate for the literal and come back unreachable, which says nothing about whether the host is up.

## Does it agree with `ping`?

Mostly, and where it does not the reason is knowable. Measured on one machine, one network, the same minute:

| Host | ICMP min / avg | This tool | |
|---|---|---|---|
| carino.systems | 40.6 / 42.2 ms | 43 ms | agrees |
| github.com | 96.3 / 98.4 ms | 102 ms | agrees |
| cloudflare.com | 4.9 / 7.0 ms | 34 ms | **5x** |
| www.cloudflare.com | 4.9 / 7.0 ms | 22 ms | better |

The first two match ICMP to within a few percent. The third does not, and the measurement is not at fault: `cloudflare.com/favicon.ico` answers **301** and redirects to `www.cloudflare.com`. The browser follows it, so every probe pays a second request to a second host — a fresh DNS lookup, TCP handshake and TLS handshake the first time, and an extra round trip every time after.

So when a reading looks too high, in order of likelihood:

1. **The target redirects.** Check with `curl -sI https://host/path`; probe the URL it points at.
2. **The figure is a total, not TTFB**, because the server sends no `Timing-Allow-Origin` — so it includes the server's own think time and the transfer. Those rows are marked *total only*.
3. **ICMP and HTTPS need not reach the same machine.** An echo request is answered by the kernel of the first anycast node that sees it; an HTTPS request has to reach something that can serve the path, which on a CDN can be a different city.

## Connection, measured before the run

Pressing **Start** measures the line first and only then begins probing. That ordering is the point: a saturated link has a full queue, and a full queue adds delay to everything behind it, so testing bandwidth *during* a latency run would not measure "latency under load" — it would corrupt every sample taken in it.

- **Downlink** — six parallel streams of CDN assets, bytes read back from `encodedBodySize` on the Resource Timing entries (exposed because cdnjs sends `Timing-Allow-Origin`). Slow start is discarded. A lower bound on the line, not a substitute for a speed test against a nearby server, and the UI says so.
- **STUN round trip** — one UDP exchange, no TLS, no server-side work. The floor to compare HTTP readings against.
- **Public host** — the STUN exchange returns the public address (a server-reflexive candidate *is* the address the server saw), and a PTR lookup over DNS-over-HTTPS turns it into a hostname. `acceso-201-103-33-159.prod-infinitum.com.mx` names the ISP and often the access technology; `201.103.33.159` names nothing. The address stays in the tooltip and the report. A browser has no resolver API, so this is a request to Cloudflare's DoH endpoint (Google as fallback) — it runs only inside the connection step you triggered, never on page load, and plenty of addresses have no PTR at all, in which case the field simply keeps showing the address.
- **Client identifier** — a random `CP-xxxx-xxxx` kept in local storage so several reports from the same laptop can be told apart. Not a fingerprint, not derived from hardware, cleared with site data. It is the one connection field on screen, at the end of the targets row; the rest live in **Method**, next to the prose that explains what they mean.

### Why it cannot name your network interface

There is no web API for it, and that is deliberate rather than missing. Chrome and Firefox replace WebRTC host candidates with a random `<uuid>.local` mDNS name precisely so a page cannot enumerate the network it is on. `navigator.connection.type` is the nearest thing and only Chromium on Android and ChromeOS populates it; on desktop it is undefined, and Firefox and Safari do not ship the API at all. The Interface field reads **not published** rather than guessing from the effective type.

## Using it

Static site, no build step — serve the folder or open it on GitHub Pages.

Defaults are `8.8.8.8` and `cloudflare.com`. Enter comma-separated hostnames, pick an interval, press **Start**. Each target runs its own self-correcting loop: the next wait is measured from when the last probe *began*, and a target never has two probes outstanding, so a 500 ms interval against a 900 ms host degrades to back-to-back probes rather than piling up a queue and measuring itself.

The probe path defaults to `/favicon.ico` — small, present almost everywhere, and cheap to serve. Point it at a health endpoint instead if you have one.

Background tabs are paused by default: browsers clamp timers to roughly one second there, so readings taken in a hidden tab measure the throttle rather than the network. The checkbox overrides it for a deliberate long run.

**One timer, not two.** A separate timeout selector asked the reader to reason about the relationship between "how often" and "how long before I give up", which has one sensible answer. The timeout is three intervals clamped to 2–10 s, and the interval control's tooltip says what that works out to.

## Log file mode

Drop a file anywhere on the page (from either mode), choose one, or paste the output. It never leaves the tab.

**Built for big logs.** A long PowerShell capture runs to hundreds of megabytes and millions of lines, so nothing in the pipeline holds an object per sample or the file as one string:

- The **File itself** goes to a Web Worker (cloning a File copies a handle, not its bytes), which reads it as a stream and decodes as it goes into line-aligned chunks of ~4 M characters — Chrome caps a single string near 512 M characters, and splitting a whole file into a line array would copy it again.
- Samples are stored as **typed-array columns** (~35 bytes each: line, session, target, seq, time, RTT, TTL, bytes, responder id, status, flags) and **transferred** to the page, not cloned. Responders are interned.
- Everything after the line loop is **linear**: a counting sort groups samples by run, one pass checks every summary, one pass per run interpolates the clock across outages. Late-reply bookkeeping is a 65 536-entry ring, not a map of every packet ever sent.
- The decoded text **stays in the worker**. Row tooltips fetch only the lines in view; a re-parse after an override reuses it. Each load gets its own worker, so cancelling one — or dropping a bad file — leaves the log on screen intact.
- The table maps scroll position proportionally past ~8 M px, below every browser's element-height cap. CSV is written in 50 000-row parts; XLSX/ODS refuse past their 1 048 576-row limit and say why.

Measured: a 457 MB UTF-16 PowerShell log, 3 million lines, loads in about 11 s and leaves the page heap at ~270 MB; tabs redraw in 100–300 ms.

**Formats, detected automatically** — the first 400 lines are scored against each format's patterns, and the strip shows what was found (*Auto: Windows · Español*) with an override:

| Format | Notes |
|---|---|
| Linux (iputils) | Fedora, Debian, Ubuntu; `-D` epoch prefixes, `-O` "no answer yet", `(DUP!)`, `From … Destination Host Unreachable`, IPv6 headers |
| BusyBox | Alpine, OpenWrt, routers, containers: `seq=` from 0, `round-trip min/avg/max` |
| macOS / BSD | `Request timeout for icmp_seq N`, seq-less unreachables (with the hex dump that follows), `stddev` |
| Windows | `ping` / `ping -t` in English, Spanish, Portuguese, Russian, Japanese, German and French. Replies are matched by structure (`address: … =32 … =12ms TTL=117`), not words, so `tiempo<1m` and `時間 =12ms` read the same; headers, timeouts and summaries use a phrase table per language |
| PowerShell | `Test-Connection`, both the 5.1 and the 7 table |
| Carino Ping CSV | this tool's own export, from either mode, so a run can be reloaded |

Timestamp prefixes from wrappers are stripped first: `[epoch]` (`-D`), ISO, `$(date)`, `ts` (no year — taken from the file's date), PowerShell `Get-Date` (`10/19/2026 9:59:58 AM - …`), or a bare clock. Numeric dates are ambiguous; a field over 12 anywhere in the file decides DD/MM vs MM/DD, and when nothing does, the language does and a selector appears.

**Encodings.** `ping > log.txt` in cmd writes the console's OEM code page and PowerShell 5's `>` writes UTF-16LE. BOMs are honoured, BOM-less UTF-16 is recognised by its zero bytes, and a file that is not UTF-8 is decoded as each of CP850, Windows-1252, CP866, Windows-1251 and Shift_JIS, keeping whichever reads the most localized ping words correctly. CP850 is not in the WHATWG encoding list, so its table is in `parse.js`.

**What the log does not say, recovered:**

- **Linux prints nothing for a lost packet** (without `-O`). A missing `icmp_seq` is an inferred timeout; packets lost after the last reply come from the summary's `packets transmitted`; the 16-bit counter's wrap at 65535 is followed. Late replies replace their placeholder, and duplicates are kept in the table but out of every statistic.
- **Most logs have no clock.** Without one the time axis is sequence × the interval chosen on screen (Windows timeouts are charged the 4 s they waited), and the strip says *Time: estimated*. Times of day — and so the hour-of-day view — exist only when the log has them.
- **ping's summary is a free check.** Each run's sent/received and min/avg/max are compared against what ping printed. Windows counts *Destination host unreachable* as received; this tool counts it as lost, and the check compares the Windows way.
- **Where it is going** comes from the header (`PING host (ip)`, `Pinging host [ip]`). The responder is kept separately — `From 192.168.1.1 … Unreachable` is the gateway answering, not the target — and the card names any other address that answered. One file can hold many runs (a cron job appending `ping -c 10`); each header starts a new run, and runs to the same target are analyzed together.

**Filters.** The time range (drag across the chart; double-click or ✕ to reset) and the target scope everything — tiles, cards, charts, table, exports and report. Status, an RTT threshold and *around incidents ±N* (the samples either side of every loss) filter only the table; applying them to the statistics would be meaningless.

**Charts.** Over time (each pixel column is a bucket: min–max band plus mean line, loss as red rules whose strength is the share lost — 600 000 samples draw as fast as 600), distribution (per-target share per bin; log-spaced bins when targets differ by more than 4×, everything above p99 in one overflow bin), loss per time bucket, hour of day (median per target per hour on that target's own ramp, lossy hours outlined and labelled), and TTL (a step is a route change). Every chart has a hover readout; series colours follow the target, and the order passes a colour-vision check on adjacent pairs.

**Table.** Virtualized: the DOM holds the rows in view, never the 600 000 behind them. Hovering a row shows the raw log line, or why it was inferred. Every line the parser could not read is listed under *Details*, with the summary cross-check.

Exports carry the rows the table shows — sequence, timestamp in the log's own basis, target, responder, status, RTT, TTL, source line — and re-import losslessly. The report swaps the connection section for the file's provenance and adds the cross-check.

## Exports and the report

**CSV / XLSX / ODS** carry the complete per-sample record, phase columns included. CSV needs no library; SheetJS is vendored and loaded only when one of those buttons is pressed.

**Report** opens a standalone HTML document in a new tab with a Print / Save as PDF button — the same approach Topo takes, and for the same reason: turning HTML into a PDF is the browser's job, so there is no PDF library in this repo (dropping jsPDF removed ~900 kB of vendored script). It prints the *distribution*, not the log: summary, per-target min/average/p50/p95/max/jitter/loss, peaks and lows, unanswered probes, the connection, the client identifier and the method. A run at half-second intervals makes hundreds of rows an hour and nobody reads row 300 — that is what the spreadsheet exports are for, and the report says so.

The report draws its charts as inline SVG, so they survive email, printing and offline viewing: latency over time (each target's average per time slice, with its fastest-to-slowest band), the share of probes lost per slice, and in Advanced a spread per target (min–max, p50–p95, average). The colours are a darker step of the screen palette, checked for colour-vision separation against white paper. A **Basic / Advanced** switch at the top of the report picks the level of detail. Basic, the default, has the verdict, four headline numbers, the charts and a short per-target table. Advanced adds the full statistics, peaks and lows, unanswered probes, the log cross-check and the method. Printing prints whichever level is on screen, and the choice is remembered.

Peaks are ranked by how far a sample sat **above its own target's median**, not by absolute time. Ranked absolutely every row comes from whichever host is furthest away, and the table just says "the slow one is slow"; ranked by excursion, a real spike on a fast host appears next to a slow host's normal traffic. Lows are each target's best sample.

## Shape

The navbar holds one primary action per mode — **Start** (which turns into a red Stop with a pulsing dot, so no separate state chip) or **Open log** — plus Clear and Method as icons and a single **Export** menu for the report and the three spreadsheet formats. The menu is positioned against the viewport, because on a phone the navbar's action strip scrolls and would clip it.

Loading a log shows a progress card — read, parse, draw — with the bytes read, then lines parsed and samples found as the worker reports them, and a Cancel that throws the worker away and keeps whatever log was on screen.

The verdict is a **badge in the navbar**, not a bar across the page: it names the conclusion in a word (*Healthy*, *Usable*, *Slow*, *Packet loss*, *No reply*) and carries the full sentence in its tooltip, which is also what the report prints. That removed a whole row from the layout.

One screen, no page scroll. The body is exactly the viewport tall with `overflow:hidden`; the shared navbar takes its 60px and the app takes the rest. The target cards and the sample log scroll inside their own panes, and the method notes live in a dialog rather than below a fold. The cards carry no panel or heading of their own — each names its target, so a frame around a list of framed things was a second line saying nothing. Verified at ten viewport sizes from 1920×1080 down to 360×640 and 740×360 (landscape phone), idle and mid-run, in both axes.

When height runs short the layout degrades in a deliberate order rather than growing a scrollbar: the tiles' caption line goes first, then the panes' minimum heights, then the verdict sentence — which is the one element whose meaning the colour of the loss tile already carries.

## Architecture

Plain ES modules, no framework, no CDN, no build step.

```
index.html · css/ping.css · i18n.js   fixed-viewport shell, method dialog
js/probe.js    the measurement: fetch + Resource Timing + STUN, cold/warm
js/stats.js    Series, quantiles, jitter, loss, verdict bands
js/viz.js      dependency-free canvas chart + SVG sparkline + phase bar
js/export.js   CSV native; SheetJS loaded from ./vendor on demand
js/speed.js    downlink throughput, parallel streams, before the run
js/client.js   client identifier, browser/platform, reverse DNS, what the OS publishes
js/report.js   the standalone printable report (Topo's approach, no PDF lib)
js/parse.js    streamed decoding, format detection, columnar parsing — pure, no DOM
js/parse-worker.js   one per load: reads the File, parses, keeps the text
js/analyze.js  the Log file mode: filters, charts, virtual table, exports
js/app.js      modes, targets, per-target loops, rendering
vendor/        xlsx (vendored, never a CDN)
fonts/         IBM Plex Sans/Mono + Red Hat Display, self-hosted
carino-navbar.js · carino-clock.js · carino-lang.js   the shared fleet chrome
```

SheetJS is fetched only when someone presses XLSX or ODS, so a page view that never exports a spreadsheet pays none of it.

The parser has its own tests, with a fixture per format, language and encoding (`tests/fixtures/`): `node --test tests/parse.test.mjs`.

Five languages (en / es / pt-BR / ja / ru) through the fleet resolver, `carino-lang.js`; a pick on any Carino subdomain applies across the fleet. **The report is translated too** — every heading, column, verdict and the whole method paragraph, with the document's own `lang` attribute set to match. That is checked programmatically rather than by eye: a test walks every `t()` key reachable from the report and asserts it resolves in all four non-English locales.

## Licence

AGPL-3.0-or-later — see [LICENSE](LICENSE).
