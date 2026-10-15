# PROTOTYPE — live dashboard on fake data

**Throwaway. Issue [#7](https://github.com/jwu02/esp32-car-telemetry/issues/7), part of [#1](https://github.com/jwu02/esp32-car-telemetry/issues/1).**
Nothing here is firmware and nothing here is meant to survive this ticket. The spec records what was learned; this code is evidence for it.

## Run it

```
node prototype/dashboard/server.mjs
```

It prints a LAN URL — open that on your phone (same Wi-Fi or hotspot as this machine). No install, no build, no dependencies, Node 20+.

The page is designed to be looked at on a phone, so look at it on a phone. `?v=a|b|c|d&ch=sse|ws|poll&hz=5|10|20` is in the URL, and the floating bar at the bottom drives everything.

## What it is

There is no car, no rig and no OBD2 port in this prototype. A fake Camry hybrid drive runs in the server (EV creep → launch → city with engine cycling → highway → regen → idle-charge, repeating), the signals are the Tier A set from [the PID research](../../docs/research/toyota-hybrid-pids.md), and everything the dashboard shows comes over one of the three candidate live channels. Fake records are already on the "device" so the export screen has a batch to offer.

Buttons worth pressing:

- **view A/B/C/D** — four answers to "what earns screen space".
- **channel SSE / WebSocket / poll** — switch live and watch the strip's byte counter and the state panel's gap/reconnect counters.
- **device rate** — changes the device's sample rate, not the browser's. Everything follows it.
- **state** — every number the prototype is keeping, including how many off-device requests the page made (should be 0).
- **ignition off** — ends the trip, seals the record, opens the 5-minute export window. Then **export…**.
- **wake on CAN** — comes back to life with the clock unset again.

## The four views, and what each one was asking

| | question | what the prototype answers |
|---|---|---|
| **A cluster** | is one number plus an engine-state word the whole dashboard? | Yes for a parked glance, no for a driver: it needs the engine state word to be legible at arm's length, and the engine state is the only thing on it that is not obvious from the windscreen. |
| **B grid** | which of these eight earn their place? | Speed, engine state, and whatever the engine is doing with the battery. Coolant, load and HV current are noise at a glance — they are debugging values. |
| **C trace** | is the shape over time the point? | The engine-on/off band is the single most informative thing in the whole prototype. The numbers below it are decoration. |
| **D ledger** | is the live view the point, or the export? | The export is the point. The live view is a heartbeat that tells you the device is awake and recording. |

## Measured, not guessed

| | value | how |
|---|---|---|
| one telemetry message | **~276 B** of JSON (25 fields) | SSE frames, 60 s capture |
| 10 Hz per connected client | 2.7 kB/s · **160 kB/min** · ~9.6 MB/hour | same |
| 20 Hz per connected client | 5.4 kB/s · 324 kB/min | rate control at 20 |
| render cost per message, 6× CPU-throttled | **0.9 – 1.2 ms** (≈6 % of a 60 fps frame), zero long tasks | Chrome, 390×844, variants A/B/C |
| polling | one TCP connect **per sample**; 5 Hz polling against a 10 Hz device silently loses half the samples (the state panel's gap counter shows it) | channel switch |
| export batch | 2.2 kB for 3 trip records + 4 rollups | export screen |
| browser memory | ~1.6–2.2 MB JS heap, flat | `performance.memory` |
| ESP32-S3 build | 866 kB app in a 1 MB partition, 37.9 kB static RAM | `pio run` size report |

Device-side numbers (not measured — the board is not bought yet) are in the finding on #7.

## The device half (ESP32-S3)

```
cd prototype/dashboard/esp32
node tools/embed.mjs                                        # page -> src/web_assets.h, stamps the build time
SSL_CERT_FILE=/etc/ssl/cert.pem ~/.platformio/penv/bin/pio run -t upload -t monitor
```

The board raises the access point **camry-telemetry** / **telemetry1234** at 192.168.4.1, serves the *same* `index.html` / `style.css` / `app.js` the laptop serves — embedded verbatim, no browser-side changes — and generates the same six-phase fake drive on the chip. Same page, same wire format: the point is to find out what the real chip costs before the design is frozen.

On the device: the server side of all three live channels (SSE on async handlers, `/api/latest` for polling), `/api/snapshot`, and the ignition-off window with its suspended-while-connected rule. Deliberately not on the device: no trip records, no rollups, no LittleFS, no export. There is nothing to export, so the ledger is empty and the export sheet counts 0 records — that is [#4](https://github.com/jwu02/esp32-car-telemetry/issues/4) and [#5](https://github.com/jwu02/esp32-car-telemetry/issues/5)'s territory, not this one's.

Measured on the *build*, not yet on a board: app 866 kB in a 1 MB partition (82.6 %), static RAM 37.9 kB (11.6 %). The live numbers — free heap with the AP up, with a phone joined, and with four SSE clients — come out of the log, which prints internal heap at boot, on every phone join/leave, and every 4 s beside the client count.

Three things that bite before the first flash:

- **PlatformIO's bundled Python has no CA store.** Without `SSL_CERT_FILE=/etc/ssl/cert.pem` every `pio` package install dies with `CERTIFICATE_VERIFY_FAILED` and leaves half-installed packages behind.
- **`version.txt` is load-bearing.** ESP-IDF runs `git describe` for `PROJECT_VER`, and a repo with no commits at all is a hard configure failure (`file failed to open for reading: .../head-ref`). `version.txt` short-circuits it, so the firmware does not care whether the docs have been committed.
- **Flash is pinned to 2 MB with a 1 MB app partition** because the board is not known and every S3 module has at least 2 MB. Leaving 826 kB of app free is fine today; the partition table should be sized properly — app *plus* the record store — once the board is chosen.

## Things the prototype found on its own

- **The device has no clock.** No RTC in the module and no internet route to NTP, so every record it writes is stamped with the firmware build time. The prototype's device boots 3 days 9 hours behind and says so in the strip. The fix that fell out of building the export screen: the exporting browser hands the device the phone's clock as part of the export handshake. It is in the prototype.
- **A warning chip nobody can dismiss is a bad warning chip.** The clock warning is on screen permanently, because on a real device that state is permanent until the next export.
- **A naive SSE resume dumps the whole backlog.** Implemented, then fixed: without a `Last-Event-ID` a connecting client must get nothing, and a reconnecting one must get a bounded replay. Handing a fresh client the ring buffer is a 500 kB burst into a device with 512 kB of SRAM.
- **"Suspended while a client is connected" is load-bearing.** Watching the export window holds it open forever, so the countdown can only be seen to expire when nothing is looking. That is correct behaviour and also a way to never deep-sleep.

## What this prototype is not

- Not the firmware, not a build, not a design for the ESP32 — it runs on a laptop so the design can happen before the hardware does.
- Not the export contract. The batch framing, the endpoint and the confirmation handshake here are invented to have something to look at; [#5](https://github.com/jwu02/esp32-car-telemetry/issues/5) owns them.
- Not the record model. The trip/rollup fields are a plausible sketch for [#4](https://github.com/jwu02/esp32-car-telemetry/issues/4) to accept or reject.
