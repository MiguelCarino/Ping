# Ping

Client-side network latency measurement — part of [Carino Systems](https://carino.systems). Live at **ping.carino.systems**.

Round trip, jitter, packet loss and the DNS/TCP/TLS/TTFB split for any set of websites, measured from your own browser. Nothing is uploaded; the only traffic is the probes themselves, going to the hosts you name.

## What it measures, and what it cannot

**A browser cannot send ICMP.** No web API exposes raw sockets, so the `ping` command's actual protocol is unavailable to any web page — and a page claiming otherwise is timing something else. What this does instead:

- **HTTPS round trip.** One `fetch` per probe, `mode: 'no-cors'`, cache and credentials off, aborted at the timeout via `AbortController`. An opaque response means the host answered; a rejection means it did not. That distinction is the measurement.
- **The phase split, where the server permits it.** If a target sends `Timing-Allow-Origin`, the Resource Timing API exposes DNS, TCP, TLS, TTFB and transfer separately, and the headline number becomes **time-to-first-byte** — mostly propagation delay, and the closest thing a browser has to an ICMP RTT. Without that header only the total is visible, which still contains server processing and transfer time. Every card and row says which one it got.
- **Cold vs warm.** The first request to a host pays DNS plus both handshakes — routinely several times the steady-state round trip. It is shown, exported, and excluded from every statistic.
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
- **Public address** — falls out of the same STUN exchange; a server-reflexive candidate *is* the address the server saw.
- **Client identifier** — a random `CP-xxxx-xxxx` kept in local storage so several reports from the same laptop can be told apart. Not a fingerprint, not derived from hardware, cleared with site data.

### Why it cannot name your network interface

There is no web API for it, and that is deliberate rather than missing. Chrome and Firefox replace WebRTC host candidates with a random `<uuid>.local` mDNS name precisely so a page cannot enumerate the network it is on. `navigator.connection.type` is the nearest thing and only Chromium on Android and ChromeOS populates it; on desktop it is undefined, and Firefox and Safari do not ship the API at all. The Interface field reads **not published** rather than guessing from the effective type.

## Using it

Static site, no build step — serve the folder or open it on GitHub Pages.

Enter comma-separated hostnames, pick an interval, press **Start**. Each target runs its own self-correcting loop: the next wait is measured from when the last probe *began*, and a target never has two probes outstanding, so a 500 ms interval against a 900 ms host degrades to back-to-back probes rather than piling up a queue and measuring itself.

The probe path defaults to `/favicon.ico` — small, present almost everywhere, and cheap to serve. Point it at a health endpoint instead if you have one.

Background tabs are paused by default: browsers clamp timers to roughly one second there, so readings taken in a hidden tab measure the throttle rather than the network. The checkbox overrides it for a deliberate long run.

**One timer, not two.** A separate timeout selector asked the reader to reason about the relationship between "how often" and "how long before I give up", which has one sensible answer. The timeout is three intervals clamped to 2–10 s, and the interval control's tooltip says what that works out to.

## Exports and the report

**CSV / XLSX / ODS** carry the complete per-sample record, phase columns included. CSV needs no library; SheetJS is vendored and loaded only when one of those buttons is pressed.

**Report** opens a standalone HTML document in a new tab with a Print / Save as PDF button — the same approach Topo takes, and for the same reason: turning HTML into a PDF is the browser's job, so there is no PDF library in this repo (dropping jsPDF removed ~900 kB of vendored script). It prints the *distribution*, not the log: summary, per-target min/average/p50/p95/max/jitter/loss, peaks and lows, unanswered probes, the connection, the client identifier and the method. A run at half-second intervals makes hundreds of rows an hour and nobody reads row 300 — that is what the spreadsheet exports are for, and the report says so.

Peaks are ranked by how far a sample sat **above its own target's median**, not by absolute time. Ranked absolutely every row comes from whichever host is furthest away, and the table just says "the slow one is slow"; ranked by excursion, a real spike on a fast host appears next to a slow host's normal traffic. Lows are each target's best sample.

## Shape

One screen, no page scroll. The body is exactly the viewport tall with `overflow:hidden`; the shared navbar takes its 60px and the app takes the rest. The target cards and the sample log scroll inside their own panes, and the method notes live in a dialog rather than below a fold. Verified at ten viewport sizes from 1920×1080 down to 360×640 and 740×360 (landscape phone), idle and mid-run, in both axes.

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
js/client.js   client identifier, browser/platform, what the OS publishes
js/report.js   the standalone printable report (Topo's approach, no PDF lib)
js/app.js      targets, per-target loops, rendering
vendor/        xlsx (vendored, never a CDN)
fonts/         IBM Plex Sans/Mono + Red Hat Display, self-hosted
carino-navbar.js · carino-clock.js · carino-lang.js   the shared fleet chrome
```

SheetJS is fetched only when someone presses XLSX or ODS, so a page view that never exports a spreadsheet pays none of it.

Five languages (en / es / pt-BR / ja / ru) through the fleet resolver, `carino-lang.js`; a pick on any Carino subdomain applies across the fleet.

## Licence

AGPL-3.0-or-later — see [LICENSE](LICENSE).
