# Toyota hybrid signals over OBD-II — what can actually be polled

Research ticket: *which Toyota hybrid signals can actually be polled on this car, and are any of them stable enough to depend on?*

**Target vehicle:** 2026 Toyota Camry "Sport Lite" (GAC Toyota China), XV80 generation, TNGA-K, 2.0 L **M20F** hybrid.
**Device constraint:** requests only, on the OBD2 connector. No commands. No actuation, no configuration, no clearing.

**Date of research:** 2026-10-14.

---

## How to read the confidence ratings

| Rating | Means |
|---|---|
| **High** | Reproduced by ≥2 independent sources, or shipped in a vendor product, or recorded from a real vehicle with response bytes. |
| **Medium** | Single credible source, or a vendor list, or a recorded enumeration without a validated decode. |
| **Low** | One forum post, or a source that conflicts with every primary source. |
| **Not documented** | Nobody has published it. Stated explicitly rather than inferred. |

**The controlling caveat for this whole document.** Every byte offset and scaling factor below that was not measured on *this* car is a hypothesis. The community's Mode 21/22 work is overwhelmingly on **Gen 2/Gen 3 Prius (2004–2015)** and, more recently, **TNGA Corolla/RAV4 (2019+)**. Almost nothing is on the XV80 Camry, and **nothing at all is published for the M20F**. See *Stability verdict*.

Also note the project's own vocabulary applies here: a *request* is permitted, a *command* is never permitted, and the *signal inventory* is established by measurement on the car — never by what the standard says should be available.

---

## 0. The physical constraint, restated

`GLOSSARY.md` says the OBD2 connector reaches only the **diagnosis bus**, and the **gateway ECU** does not relay internal broadcasts out to the connector. This is confirmed by the sources below: every high-value hybrid signal found is a **diagnostic request/response**, never a passive broadcast.

The passive-sniffing work that decodes the richest engine-state information — PriusChat's decode of CAN frames `0x348` / `0x3C8` between the HV ECU and the ECM, which contains explicit *ICE stop request*, *ICE idle request* and *HV battery charge request* bits — is on the **powertrain bus** and is **not reachable from the OBD2 connector**.
<https://priuschat.com/threads/decoding-can-messages-0x348-0x3c8-as-described-by-peef.110042/>

This closes off one whole avenue and is worth stating plainly: the best-documented engine-on signal in the community is not available from where the device is plugged in.

---

## 1. ECU addresses — verified, not repeated

**Verified directly against `commaai/opendbc` at `master`**, file `opendbc/car/toyota/values.py`, in `FW_QUERY_CONFIG.extra_ecus`:

```python
# Hybrid control computer can be on 0x7e2 (KWP) or 0x7d2 (UDS) depending on platform
(Ecu.hybrid, 0x7e2, None),  # Hybrid Control Assembly & Computer
(Ecu.hybrid, 0x7d2, None),  # Hybrid Control Assembly & Computer
```

Immediately above it, in a comment enumerating *"All known ECUs on a late-model Toyota vehicle **not queried here**"*:

```
# Responds to UDS:
# - Combination Meter (0x7c0)
# - HV Battery (0x713, 0x747)
# - Motor Generator (0x716, 0x724)
```

<https://github.com/commaai/opendbc/blob/master/opendbc/car/toyota/values.py>

**So the ticket's premise checks out, with three corrections worth carrying:**

1. `0x7E2` (KWP) / `0x7D2` (UDS) is confirmed **verbatim**. The KWP-vs-UDS split is openpilot's own framing and is the single most important fact in this document.
2. `0x713` / `0x747` are real, but they appear **only as a comment listing ECUs openpilot deliberately does not query**, filed under *"Responds to UDS"*. They are not a tested decode path. Treat them as leads, not as a supported interface.
3. The originating PR text says *"0x712/0x7d2 Hybrid Control"*, while the merged code says `0x7e2`/`0x7d2`. Probe both. <https://github.com/commaai/openpilot/pull/28628>

**Corroboration from a working vendor product.** ScanGauge ships X-Gauge commands placing the hybrid battery at header **`747`** on Prius Prime and at header **`7D2`** on "2020 Corolla Hybrid, 2019+ RAV4 Hybrid, 2018+ Camry Hybrid, 2019+ Avalon Hybrid". <https://www.scangauge.com/support/x-gauge-commands/toyota-lexus-scion/>

**Cross-check on openpilot's own coverage.** opendbc contains **no hybrid battery or engine-state decoding at all**. The Toyota powertrain DBCs are `toyota_2017_ref_pt.dbc`, `toyota_prius_2010_pt.dbc`, `toyota_iQ_2009_can.dbc`; the only hybrid-adjacent signal in the DBC set is `GEAR_PACKET_HYBRID` (SECOC platforms). `carstate.py` reads no battery, no engine RPM and no fuel signal. And `values.py` **has no XV80 / 2025 / 2026 Camry platform** — the newest Camry entry is `Toyota Camry Hybrid 2021-24`.

**Consequence:** openpilot's ECU addresses come from XV70-era and earlier platforms. They are a good starting hypothesis for the XV80 and nothing more.

---

## 2. Mode 21 versus Mode 22 — what is true

### The protocol facts (high confidence, standards)

| Service | KWP2000 (ISO 14230-3) | UDS (ISO 14229-1) | Effect |
|---|---|---|---|
| `0x21` | **ReadDataByLocalIdentifier** — 1-byte ID | **Reserved** | read-only |
| `0x22` | ReadDataByCommonIdentifier | **ReadDataByIdentifier** — 2-byte ID | read-only |

ISO 14230-3:1999 Table 7 lists `0x21` as *ReadDataByLocalIdentifier* and `0x22` as *ReadDataByCommonIdentifier*, and gives the positive-response rule **response SID = request SID + 0x40** — so `0x21` answers `0x61` and `0x22` answers `0x62`.
<https://cdn.standards.iteh.ai/samples/iso/iso-14230-3-1999/d3588e9451af46f1917d23f75b9aea2e/iso-14230-3-1999.pdf>

ISO 14229-1's service list puts `0x22` = ReadDataByIdentifier and marks **`0x1A`–`0x21` as reserved**.
<https://uds.readthedocs.io/en/stable/pages/knowledge_base/service.html>

**This is the mechanism behind the migration.** A Toyota powertrain ECU that moved from KWP2000 to UDS *cannot* answer Mode 21, because in UDS the service number `0x21` is reserved. That is a protocol-level reason, not a rumour. It explains the split openpilot documents as `0x7e2 (KWP)` / `0x7d2 (UDS)`.

### The measured evidence (medium-high confidence)

**Mode 21 was rejected outright on a Gen 4 Prius HV ECU.** Scanning all Mode 21 PIDs against header `7D2` returns, for every PID:

```
7DA 03 7F 21 11 00 00 00 00
```

`7F` = negative response, `21` = the service, `11` = **serviceNotSupported**. Two independent users reported the identical string; `vincent1449p` read it correctly as *"mode 21 is not supported by this ECU"* and pointed to Mode 22 with 2-byte PIDs as the replacement.
<https://priuschat.com/threads/gen-iv-prius-custom-pids-for-torque-app.163271/>

> **Correction to the ticket's framing.** The frequently-quoted string is `7F 21 11` (service not supported), **not** `7F 21 12` (sub-function not supported). The two are not equivalent. The famous `7F 21 12` example circulates from a Prius v thread where a *Mode 21 engine PID was sent to the HV ECU* — the HV ECU correctly answered "sub-function not supported" for a PID it does not own. That instance is anecdotal and is **not** evidence that Mode 21 disappeared. <https://priuschat.com/threads/prius-v-odb-mode-21.161827/>

**Mode 21 is not dead everywhere.** On a 2021 GR Yaris (TNGA), Mode 21 PID `62` on header `7D0` answers normally. So the migration is **per-ECU, not per-car**: it is the *hybrid* ECU that moved to Mode 22. <https://www.gr-yaris.co.uk/threads/reverse-engineering-pids.4680/>

**The transition is visible as a date boundary in open-source vehicle data.** The `OBDb/Toyota-RAV4-Hybrid` repo records, per model year, with real response bytes:

| Model year | Hybrid control | HV battery |
|---|---|---|
| 2016–2017 | `7E2.7EA.21xx` — **Mode 21** | `7E3.7EB.21CE`, `21CF`, `21D0` — **Mode 21** |
| 2019+ | `7D2.7DA.22xxxx` — **Mode 22** | `747.74F.22182E` — **Mode 22** |

<https://github.com/OBDb/Toyota-RAV4-Hybrid> — see `signalsets/v3/default.json` and `tests/test_cases/<year>/command_support.yaml`.

That is the cleanest single artefact on the question: the same community dataset carries **Mode 21 commands for 2016–2017 cars and Mode 22 commands for 2019+ cars**, with per-year recorded test cases.

### What is known about the M20F / XV80 specifically

**Nothing.** No Mode 21 or Mode 22 PID list exists publicly for the M20F engine, the M20F hybrid system, or the XV80 Camry hybrid. This was checked against the sources listed in *Sources*, and it is a genuine negative.

What exists for the XV80 is adjacent and does not contain PIDs:

- Engine identification only — "2.0 CVT (197 hp) M20F", XV80 China market, 2023–2026: <https://autowoop.com/cars/toyota/camry/9-generation-xv80-china-market>
- Coding and fault codes, no live-data PIDs: <https://carcoding.app/en/supported-vehicles/toyota/camry-xv80/>
- A commercial tool (SECONS ToCOM) confirms the data *exists* — "Toyota Camry HV AXVH71 2019-2020 A25A-FXS → Hybrid Control: **1461 data identifiers**" — but publishes no PIDs, and that is the **XV70 / A25A-FXS**, not the XV80 / M20F. <https://www.obdtester.com/tocom-eculist/toyota/camry_hv_(eur,tmmk)/axvh71_2019_10_2020_10/a25a_fxs>

The closest published analogue is the **2021 EU Corolla TS hybrid (2ZR/M20A, Li-ion)** thread, where the owner reverse-engineered the set from scratch because the Gen 4 Prius and ScanGauge parameters "don't fit", and a 2024 owner then confirmed that "MG1 and MG2 speed work well, also battery resistances and temperatures are also working. I can even see the inverter temps" — but "nothing related to MG1 or MG2 temperatures". **Partial survival across the 2022 powertrain refresh, not wholesale survival.**
<https://priuschat.com/threads/corolla-ts-hybrid-custom-torque-pids.253928/>

---

## 3. Ranked list of hybrid signals worth attempting

Ranked by *value to this project* (engine-on vs EV being the top concern), then by confidence.

### Tier A — standard Mode 01 answered by the hybrid ECU `0x7E2` (read-only, standardised, best odds)

This is the most important finding in this document. The `OBDb/Toyota-Camry` repo records, **for model year 2026**, having enumerated the hybrid control ECU at `0x7E2` and received answers to **standard Mode 01 PIDs**, including two hybrid-specific ones.
<https://github.com/OBDb/Toyota-Camry/blob/main/tests/test_cases/2026/command_support.yaml>

| # | Signal | Request | Response | Formula | Confidence |
|---|---|---|---|---|---|
| 1 | **Hybrid/EV battery pack remaining life (SOC)** | `7E2 01 5B` (or functional `7DF 01 5B`) | `7EA 03 41 5B A` | `A * 100 / 255` % | **Medium-high** — answered per 2026 Camry enumeration; standard PID definition is High |
| 2 | **Hybrid/EV vehicle system data — battery voltage, current, mode** | `7E2 01 9A` | `7EA 08 41 9A <6 bytes>` | J1979-DA; see caveat below | **Medium** — answered per 2026 Camry enumeration; byte layout not pinned down publicly |
| 3 | Engine RPM | `7E2 01 0C` | `7EA 04 41 0C A B` | `(256A+B)/4` rpm | **High** (standard); see ICE-spin caveat |
| 4 | Vehicle speed | `7E2 01 0D` | `7EA 03 41 0D A` | `A` km/h | High |
| 5 | Engine coolant temp | `7E2 01 05` | `7EA 03 41 05 A` | `A - 40` °C | High |
| 6 | Calculated engine load | `7E2 01 04` | `7EA 03 41 04 A` | `A * 100/255` % | High |
| 7 | Intake air temp / ambient | `7E2 01 0F`, `7E2 01 46` | — | `A - 40` °C | High (ambient `0x46` useful for trip context) |
| 8 | **Run time since engine start** | `7E2 01 1F` | `7EA 04 41 1F A B` | `256A+B` s | High |
| 9 | **Odometer** | `7E2 01 A6` | `7EA 06 41 A6 A B C D` | `(256A+B)*256*256 + (256C+D)` km, /10 | **Medium** — answered per enumeration; `0xA6` is a J1979-DA PID. Distinctly useful: cumulative distance survives the device being asleep |
| 10 | Gear / N-D-G status | `7E2 01 65` | `7EA 05 41 65 <4 bytes>` | bit flags | Medium |
| 11 | Accelerator pedal D/E | `7E2 01 49`, `7E2 01 4A` | — | `A * 100/255` % | Medium |
| 12 | Barometric pressure / module voltage | `7E2 01 33`, `7E2 01 42` | — | `A` kPa; `256A+B`/1000 V | High |

**Why `0x9A` is the prize.** SAE J1979 defines Mode 01 PID `0x9A` as *"Hybrid/EV Vehicle System Data, Battery, Voltage"*, 6 bytes. A UNECE working paper on OBFCM explicitly names the instantaneous hybrid parameters already available in J1979 as **vehicle speed (0D), battery current (9A), battery voltage (9A), battery SOC (5B), SOH (B2), battery temperature (B7)** — i.e. `9A` carries **current and voltage**, and the mode field is the EV/engine distinction.
<https://en.wikipedia.org/wiki/OBD-II_PIDs> · <https://obd2pid.com/pids/01-9A> · <https://wiki.unece.org/download/attachments/265978082/Summary%20UNR154%20LDV%20OBFCM%20technical%20exploration%20-%20WLTP%20Ad-hoc.pdf>

The OBDb dataset names the `0x9A` signals as `EHEV_MODE, EHEV_MODE_SUP, HEV_BATT_A, HEV_BATT_A_SUP, HEV_BATT_V, HEV_BATT_V_SUP, HEV_MODE, HEV_MODE_SUP` — value plus a "supported" bit per quantity. **The exact bit/byte split is not published in any source found**, so the mode field must be identified empirically by correlating against engine RPM (see *What to do on the car*).

**PID `0x5B` naming trap.** Its J1979 name is *pack remaining life*, not *state of charge*; most tools label it SOC. On a healthy Toyota hybrid it should sit in the 40–80 % band, which is a usable sanity check — a value pinned at 0 or 100 means the formula or the ECU is wrong.
<https://obd2pid.com/pids/01-5B>

### Tier B — Mode 22 on the HV ECU (documented, vendor-shipped, model-year fragile)

ScanGauge ships these as working product commands. They are the highest-quality *Mode 22* evidence available, but they are documented for **XV70 / A25A-FXS-era** cars.

| # | Signal | Request | Response | Formula | Confidence |
|---|---|---|---|---|---|
| 13 | Hybrid battery SOC | `7D2 22 7A76` | `7DA 04 62 7A76 A` | `A * 20 / 51` % | **Medium-high** (vendor-shipped) |
| 14 | Hybrid battery voltage | `7D2 22 7A53` | `7DA .. 62 7A53 ...` | `C * 4` V | Medium-high |
| 15 | Hybrid battery current | `7D2 22 7A53` | same response as above | byte offset not published | Medium |
| 16 | Inverter coolant temperature | `7D2 22 1093` | — | `A * 9/5 - 40` °F | Medium |
| 17 | Generator inverter temperature | `7D2 22 1089` | — | `A * 9/5 - 40` °F | Medium |
| 18 | Boosting converter temp (upper / lower) | `7D2 22 10AB` | — | `A * 9/5 - 40` / `B * 9/5 - 40` °F | Medium |

<https://www.scangauge.com/support/x-gauge-commands/toyota-lexus-scion/> · translation to Torque syntax: <https://priuschat.com/threads/gen-iv-prius-custom-pids-for-torque-app.163271/>

**Modern RAV4 (XA50, TNGA-K — the nearest sibling platform) equivalents**, from a signalset with recorded response bytes:

| # | Signal | Request | Response | Formula | Confidence |
|---|---|---|---|---|---|
| 19 | State of charge | `7D2 22 1F5B` | `7DA 04 62 1F5B A` | `A * 100 / 255` % | **High** — recorded bytes verified: `62 1F 5B 25` → 14.51 %, `... D0` → 81.57 % |
| 20 | HV battery voltage | `7D2 22 1F9A` | — | `mul 156.25 / 10000` V | High (same source) |
| 21 | HV battery current | `7D2 22 1F9A` | — | `div 10`, **signed** A | High (same source) |
| 22 | Motor RPM and torque | `7D2 22 10A1` | — | — | High |
| 23 | Inverter coolant temperature | `7D2 22 10B2` | — | — | High |
| 24 | HV battery current + voltage (alt.) | `7E2 22 1F9A` | — | — | Medium |

`tests/test_cases/2021/commands/7D2.7DA.221F5B|fc=1,f=2018-.yaml`:
```yaml
- expected_values: {RAV4HYBRID_SOC: 14.5098}
  response: 7DA04621F5B25
- expected_values: {RAV4HYBRID_SOC: 81.56863}
  response: 7DA04621F5BD0
```
<https://github.com/OBDb/Toyota-RAV4-Hybrid>

Note the **disagreement between platforms**: ScanGauge says `7A76` carries SOC; the RAV4 set says `1F5B`. Both may be right for their own platform — which is precisely the problem.

### Tier C — Mode 21 on `7E2` / `7E3` (Gen 2 Prius era; likely to answer `7F 21 11` on an XV80)

Included because these are the **only** publicly documented *engine-state* signals, and because the byte map is unusually well corroborated. Two independent lineages agree byte-for-byte: the community Prius tables and the OBDb RAV4 2016–2017 signalset.

| # | Signal | Request | Byte | Formula | Confidence |
|---|---|---|---|---|---|
| 25 | **Drive condition** (engine stopped / about to stop / about to start / operating / generating) | `7E2 21 C3` | 23 | raw 0–6 | **Medium** — Toyota's own Data List defines these states |
| 26 | Engine speed (from HV ECU) | `7E2 21 C3` | 14–15 | `256*O + P` rpm | High (Gen 2) |
| 27 | Target engine speed | `7E2 21 C3` | 12–13 | `256*M + N` rpm | High (Gen 2) |
| 28 | HV state of charge | `7E2 21 C3` | 18 | `0.392 * S` % | High (Gen 2) |
| 29 | HV discharge power limit (WOUT) | `7E2 21 C3` | 19 | `320 * T` W | High (Gen 2) |
| 30 | MG2 speed / torque | `7E2 21 C3` | 0–1 / 2–3 | `256A+B - 16383` rpm / `(256C+D)/8 - 500` Nm | High (Gen 2) |
| 31 | MG1 speed / torque | `7E2 21 C3` | 6–7 / 8–9 | `256G+H - 16383` rpm / `(256I+J)/8 - 500` Nm | High (Gen 2) |
| 32 | MG1 / MG2 inverter temperature | `7E2 21 C3` | 24–27 | `X - 40` **or** `X - 50` °C — disputed | Medium |
| 33 | HV SOC, current, per-block voltage | `7E3 21 CE` | 0 / 1–2 / pairs | `0.5*A` % / `(256B+C)/100 - 327.68` A / 14 blocks | High (Gen 2 NiMH) |
| 34 | Delta SOC, SOC at ignition-on, SOC max/min | `7E2 21 98` | — | — | Medium |
| 35 | Engine run time | `7E2 21 01` | 10–11 | `256*J + K` s | Medium |
| 36 | **Fuel cut / fuel cut for engine stop request** | `7E0 21 49` (bit 92), `7E0 21 37` (bits 121/127), `7E0 21 E6` (bit 9) | bit flags | boolean | Medium |

Sources: <https://github.com/gerdbremer/Prius-gen2-torque-PIDs> · <https://attachments.priuschat.com/attachment-files/2021/09/211662_Prius22009_CAnCodes.pdf> · <https://priuschat.com/threads/canbus-pids.80206/> · <https://www.eaa-phev.org/wiki/Prius_PHEV_TechInfo> · <https://seandippold.com/2017/10/25/determining-health-prius-hybrid-battery/>

**Independent cross-validation.** The OBDb RAV4 signalset's Mode 21 `21C3` decode reproduces the community Gen 2 Prius byte map exactly — MG2 RPM at byte 0 with `-16383` offset, MG1 RPM at byte 6 with `-16383`, engine speed at byte 14, target engine speed at byte 12, WOUT at byte 19 with `× 320`, HV SOC at byte 18 with `× 0.392`. Two unrelated lineages arriving at identical offsets is the strongest evidence in this document that the Gen 2 map is real.

**The un-resolved `21C3` temperature offset.** Some sources give `X - 40` °C for MG1/MG2 inverter and motor temperatures; others give `X - 50`, with one poster stating explicitly: *"i confirm 50 °C ofset for inverter_MG1, inverter_MG2, MG1, MG2 and boost_converter. But 40 °C for catalyst, intake_air_temp."* This is a live, unresolved disagreement. **Any temperature field must be checked against a known ambient reading before it is trusted.**

---

## 4. Fuel consumption — the honest answer

**Standard PID `0x5E` (engine fuel rate) has no confirmed public evidence of working on any Toyota hybrid, and the whole Toyota hybrid tool ecosystem derives fuel some other way. On this car it is unknown and must be measured.**

### What the evidence says

- **`0x5E` is absent from the decoded supported-PID bitmap of a Gen 2 Prius.** The `0100`/`0120`/`0140` bitmaps for a 2009 Prius list `0x01,0x03–0x07,0x0C,0x0D,0x0E,0x0F,0x10,0x11,0x13,0x15,0x1C,0x1F,0x20` / `0x21,0x24,0x30,0x31,0x33,0x3C,0x3E,0x40` / `0x42–0x47,0x4C,0x4D,0x4E`. `0x5E` appears in none of them — **and neither does `0x2F` (fuel level)**.
  <https://attachments.priuschat.com/attachment-files/2021/09/211662_Prius22009_CAnCodes.pdf>
- **`0x5E` is "seldom used" industry-wide.** HEM Data: *"PID $5E defines the Injector Flow Rate in SAE standard J1979 for OBD-II, however, it is seldom used."* <https://hemdata.com/products/dawn/enews/fuel-economy-obd/>
- **Hybrid Assistant — the reference app for Toyota hybrids — never uses a fuel-rate PID.** It lists its fuel source per model: Auris = *Injection volume*; Corolla 1.8 = *Injection volume*; Corolla 2.0 = *MAF*; RAV4 MY19 = *MAF*; Lexus UX = *MAF*. <http://hybridassistant.blogspot.com/p/cars.html>
- **Templates claiming `0x5E` works on a Camry are not trustworthy.** `obdport.com` lists `0x5E` for both Camry XV70 and Corolla Hybrid E210 with near-identical boilerplate, and its Mode 22 catalogue (`0x1FE0` "true SoC", `0x1968`–`0x1975` blocks, `0x2135` MG1 RPM) appears **nowhere else** and conflicts with every primary source — the real documented Toyota Mode 22 SoC is `7A76`, not `1FE0`. It also prints a **J1939 9-pin Deutsch truck pinout on a Toyota Corolla page**. Treat as machine-generated. <https://obdport.com/vehicles/toyota/camry> · <https://obdport.com/corolla>
- **Ruptela** lists "(100) Engine fuel rate l/h (Petrol)" for Camry XV80 — but shows the *identical* parameter list for unrelated vehicles, i.e. a firmware capability template, and the extraction does not even preserve which rows are ticked. <https://vehicles.ruptela.com/vehicle/47709>

### The one piece of platform-specific counter-evidence

`OBDb/Toyota-Camry` for **model year 2026** contains an internal contradiction that must be reported rather than resolved:

- `7DF.015E` — a **functional-address** request for PID `0x5E` — appears in `supported_commands_by_ecu`.
- `7E0.015E:FUEL_RATE` — the **same PID physically addressed to the engine ECU** — appears in `unsupported_commands_by_ecu`.
- `700.708.22F19D:CAMRY_ENG_FUEL_RATE, CAMRY_VEH_FUEL_RATE` — a Mode 22 fuel-rate PID — **also** appears in `unsupported_commands_by_ecu`.

For contrast, on the **2025 RAV4 Hybrid**, `7E0 015E:FUEL_RATE` *is* listed as supported, while `700.708.22F19D` is not.
<https://github.com/OBDb/Toyota-Camry> · <https://github.com/OBDb/Toyota-RAV4-Hybrid>

The dataset's `unsupported_commands_by_ecu` semantics are **not publicly documented**, the `7DF` list contains extended PIDs that no other source confirms, and the repo's per-year `commands/` directory holds far fewer validated decodes than the support list implies. **This dataset cannot settle the question.** It does, however, mean that "`0x5E` might now answer on a current TNGA hybrid" is no longer an unreasonable hypothesis — it is a hypothesis the owner can settle with one request.

### What fuel *is* derivable from

| Route | Available? | Assessment |
|---|---|---|
| `0x5E` engine fuel rate | **Unknown on this car** | One request to `7E0 01 5E` and `7DF 01 5E` settles it. Expected absent; possibly present. |
| `0x2F` fuel level (percent) | Absent on the Prius engine ECU; RAV4 owner: *"it's not supported via a standard pid"* | Not a viable primary source |
| **Mode 22 fuel level** | `7C0 22 1022` — *Fuel remaining*, litres, filter `2018+` — supported on the **2026 Camry** per OBDb | **Medium.** Useful for tank-level sanity, not for instantaneous consumption. Resolution is coarse and deliberately damped; Prius tank level broadcasts at ~0.2 Hz and steps in half-litres. <https://github.com/meatpiHQ/wican-fw/discussions/509> |
| **MAF (`0x10`) × stoichiometric** | `0x10` **is** supported on Toyota hybrids | The practical path, and what Hybrid Assistant uses on RAV4/Corolla 2.0/Lexus UX. `fuel_L/h = MAF_g/s × 3600 / (14.7 × 745)`. Accuracy ~5–10 % |
| Injector pulse width / volume | Proprietary Mode 21 only (`7E0 21F3` Gen 2, `7E0 213C` Gen 3) | **Fragile and hybrid-hostile.** The Gen 1 Prius PID set warns: *"Fuel Injection time for cyl #1 … remains not 0 when engine is stopped. Must be combined with 'Drive Situation ID'."* Moved to Mode 22 on 2021+ Toyotas, so Prius-era PIDs will not work as-is |
| Factory fuel-rate Data List | Exists internally — Camry XV70 and Lexus ES Data Lists both show *"Engine Fuel Rate … 0–1310.7 gm/sec"* | **No published PID mapping.** Data List items are documented by *name* only |

<https://github.com/kutasg/Prius-gen1-torque-PIDs> · <https://www.scangauge.com/support/x-gauge-commands/toyota-lexus-scion/> · <https://www.tocamry.com/data_list_active_test-3255.html> · <https://www.lexguide.net/data_list_active_test-3022.html> · <https://priuschat.com/threads/measuring-geniii-prius-energy-power-flow-with-obd.115971/>

### Why MAF is unsafe as a *silent* fallback on a hybrid

MAF-derived fuel is wrong in ways that produce plausible numbers:

1. **Fuel cut on deceleration** — the engine spins with injectors off while MAF still reads non-zero → **over-reads**.
2. **Cold-start and high-load enrichment** runs richer than 14.7 → **under-reads**.
3. **E10 fuel** shifts stoichiometric AFR to ~14.1–14.2, biasing the constant.
4. **M20F is Atkinson-cycle** and frequently runs lean; a single 14.7 constant is a rough approximation.
5. **ICE spin without combustion** — PriusChat's decode of the HV→ECM frames identifies an explicit *ICE SPIN MODE* above ~64 km/h where there is *"No fuel flow, ICE rpm > 0"*, with MG1 motoring the engine. MAF is not guaranteed to read zero here.

That last point is the crux of the whole ticket and deserves restating: **on a Toyota hybrid the engine can be turning at speed with no fuel flowing.** Engine RPM is therefore *not* a fuel-burn signal, and any derivation that assumes it is will be silently wrong.

### Verdict on fuel

**Do not ship a fuel-consumption figure derived from a reverse-engineered PID.** If fuel is wanted, the defensible options are, in order:

1. Measure whether `01 5E` answers on this car. If it does, use it — it is the only route that is both standard and direct.
2. Otherwise use **MAF-based** fuel with a user-calibrated correction factor, and label it as an estimate.
3. If a precise figure is required later, the highest-fidelity route is the **broadcast fuel-consumption frame** the combination meter consumes — *"The combination meter calculates the current fuel consumption based on a vehicle speed signal from the skid control ECU, a total fuel injection signal from the ECM"* — but that is a broadcast on the powertrain bus, **not reachable from the OBD2 connector**, and would require the camera-connector tap already contemplated in `GLOSSARY.md`. <https://lemon-manuals.la/Toyota/2022/Corolla%20SE.../METER%20%2F%20GAUGE%20SYSTEM%20%28for%20HV%20Model%29/>

---

## 5. The safety line

Every service discussed in this document is a **read** service. Nothing in Tiers A–C writes vehicle state. But the modes live next to dangerous neighbours, and the line should be written down rather than assumed.

From ISO 14230-3:1999 Table 7 and ISO 14229-1:

| Service | Name | Verdict |
|---|---|---|
| `0x01`, `0x02` | Current / freeze-frame data | **Read — permitted** |
| `0x21` | ReadDataByLocalIdentifier (KWP) | **Read — permitted** |
| `0x22` | ReadDataByIdentifier (UDS) | **Read — permitted** |
| `0x3E` | TesterPresent | Keep-alive — no state change (see caveat) |
| `0x10` | DiagnosticSessionControl | Session change. Borderline; generally required and non-destructive |
| `0x27` | SecurityAccess | **Unlocks the writing services. Do not send.** |
| `0x2E`, `0x3B` | WriteDataBy(Common/Local)Identifier | **Command — never** |
| `0x2F`, `0x30` | InputOutputControlByIdentifier / by LocalIdentifier | **Actuation — never** |
| `0x31`, `0x32`, `0x33` | Start/Stop/RequestRoutine | **Actuation — never** |
| `0x34`–`0x3A` | Download / upload / transfer | **Flash — never** |
| `0x14` | ClearDiagnosticInformation | **Command — never** |
| `0x11` | ECUReset | **Command — never** |

**Two specific flags.**

1. **A vendor page suggests "some Mode 22 routes require active tester-present (0x3E) heartbeat" on gatewayed Toyota platforms.** `0x3E` itself only keeps a diagnostic session alive and does not change vehicle state, but it is not a data request either, and the claim is **unverified** — it comes from the same low-trust `obdport.com` material. If it is ever added, it must be added as an explicitly-reviewed exception, not slipped in as a side effect. <https://obdport.com/corolla>
2. **The single most dangerous thing a hybrid-PID project can do is copy a "setting" PID.** Torque PID packs in the wild mix read PIDs with PIDs that disable seat-belt or reverse beeps. The Prius PHV pack even ships them in a separate `config` file for exactly this reason. Any PID pack imported wholesale must be filtered to read-only modes `0x01`/`0x21`/`0x22` before it touches the car. <https://priuschat.com/threads/2012-2015-prius-phv-custom-pids-for-torque-android-app.104779/>

The project already states that a *Command* is never permitted and that an ADR records this. This section is written to be usable as that ADR's technical appendix.

---

## 6. Stability verdict

**No. Do not depend on a reverse-engineered hybrid PID in a firmware spec.** Concretely, from the evidence in this document:

1. **The PID namespace itself is not stable across generations.** Gen 2 and Gen 3 Prius put MG1/MG2 on one `21C3` frame; Gen 3 moved them to separate PIDs `2161`/`2162`/`2167`/`2168`. The Gen 2 byte map is simply wrong for Gen 3. <https://priuschat.com/threads/geniii-prius-custom-pids-for-torque-app.98693/>
2. **The service mode changed with the protocol, not on a schedule the project can track.** `0x7E2` (KWP, Mode 21) became `0x7D2` (UDS, Mode 22). That is visible as a hard filter in community vehicle data.
3. **Cross-model transplant fails silently.** The Auris Hybrid owner filtered a 212-PID Prius list for his car and found *"quite large amount of those PIDs are not working"*, with no way to know in advance which. <http://zansprojects.blogspot.com/2018/12/torque-pids-for-toyota-auris-hybrid.html>
4. **Even the same PID number can return wrong values while looking perfectly healthy — the exact failure mode this project fears.** On a Gen 4 Prius Prime, the ScanGauge SoC PID `227A76` returned **positive responses** and the *same value at 0 %, 35 % and 71 % state of charge*. The user's summary: *"They are all the same."* A firmware that trusted it would have logged a plausible, constant, wrong number forever. <https://priuschat.com/threads/gen-iv-prius-prime-custom-pids-for-torque-app.176099/>
5. **The nearest analogue platform shows partial survival, not survival.** From a 2021 Corolla TS to a 2024 model: MG1/MG2 speed, battery resistances, battery temperatures and inverter temps carry over — MG1/MG2 temperatures do not. The author's own warning: *"since 2022 toyota updated their powertrains, so my PIDs may not fit to you."* <https://priuschat.com/threads/corolla-ts-hybrid-custom-torque-pids.253928/>
6. **The offset disputes never got resolved.** The `21C3` hybrid temperature offset is `-40` in some sources and `-50` in others, and nobody has settled it publicly. If the community cannot settle a constant offset on a platform it has owned for fifteen years, the project should not assume one on a car nobody has published on.
7. **The catalogue itself is contaminated.** Two of the most confident-looking sources found (`obdport.com`, `Ruptela`) are templated or machine-generated, and the former publishes a truck pinout on a hatchback page. Anything that cites them inherits their error.

**Where this leaves the project, positively.** There is one genuinely defensible position: **the standard extension PIDs on the hybrid ECU (Tier A) are the only hybrid data worth building on**, because they are standardised, read-only, and mode-agnostic. `0x5B` (SOC) and `0x9A` (HV battery voltage, current, mode) are defined by SAE J1979 and are recorded as answered by `0x7E2` on a **2026 Camry** — this car's generation. They are the closest thing to a stable contract this project will get.

Everything in Tiers B and C is a **probe**, not a dependency. It may be read, logged, and displayed as an experimental panel; it must not be the input to a derived statistic that a human will trust.

---

## 7. What to do on the car (measurement procedure)

This is the *signal inventory* work `GLOSSARY.md` describes, and it is the only thing that can convert any Medium above into a High.

**Step 1 — establish the standard baseline (no proprietary PIDs).** Request Mode 01 on `7DF` and on `7E0`, `7E2`, `7E3`, `7E5`, `7E6` and log which addresses answer. Then enumerate `01 00`, `01 20`, `01 40`, `01 60`, `01 80`, `01 A0` on each. This alone determines whether `0x5B`, `0x9A` and `0x5E` are available on this car — and `0x5E` in particular resolves the whole fuel question in one minute.

**Step 2 — enumerate Mode 22 bitmasks on the HV ECU.** The best published how-to: bitmask PIDs sit at `0x100`, `0x200`, `0x300`, … in **steps of 256**, and *unlike* modes 01/21, a zero LSB does **not** mean the next block is empty — every block must be checked.
<https://priuschat.com/threads/corolla-ts-hybrid-custom-torque-pids.253928/>

**Step 3 — enumerate Mode 21 bitmasks on `7E2`/`7E3`.** These behave exactly like Mode 01: bitmask PIDs at `0x00`, `0x20`, `0x40`, … <https://www.eaa-phev.org/wiki/Prius_PHEV_TechInfo>

**Step 4 — identify the engine-on signal by correlation, not by assertion.** The project's central question is *when was the engine running*. The candidate signals are:

- Mode 01 `0x9A` EV/HEV mode field (not publicly mapped — find it empirically)
- Mode 01 `0x0C` engine RPM on `7E2` (non-zero = engine turning; **not** the same as engine firing)
- Mode 21 `7E2 21 C3` byte 23 *drive condition* (`0` = engine stopped … `3` = operating, `4` = generating) — but only if Mode 21 answers at all
- Mode 21 `7E0 21 49` bit 92 *fuel cut for engine stop request* and `7E0 21 37` *fuel cut* bits

Whichever is used, **validate it against a truth signal** — an audible engine, the car's own EV indicator, or a known drive where the engine never started. A "drive condition" field that is constant for a whole trip is the Prius Prime SoC failure repeating.

**Step 5 — record the raw bytes, not the decoded value.** If a PID is later found to be mis-scaled, raw bytes can be re-decoded. A decoded value that was quietly wrong cannot be recovered.

---

## Sources

**Primary (code, standards, factory documentation, recorded vehicle data)**

- commaai/opendbc, `opendbc/car/toyota/values.py` — ECU addresses, `extra_ecus` — <https://github.com/commaai/opendbc/blob/master/opendbc/car/toyota/values.py>
- commaai/openpilot PR #28628, "Toyota: query hybrid vehicle control computer ECU" — <https://github.com/commaai/openpilot/pull/28628>
- ISO 14230-3:1999 (KWP2000), Table 7 service identifiers — <https://cdn.standards.iteh.ai/samples/iso/iso-14230-3-1999/d3588e9451af46f1917d23f75b9aea2e/iso-14230-3-1999.pdf>
- ISO 14229-1 (UDS) service identifier list — <https://uds.readthedocs.io/en/stable/pages/knowledge_base/service.html>
- SAE J1979 PID index (secondary mirror of the standard's formulas) — <https://en.wikipedia.org/wiki/OBD-II_PIDs> · <https://obd2pid.com/pids/01-5B> · <https://obd2pid.com/pids/01-9A>
- UNECE OBFCM working paper, listing J1979 hybrid instantaneous parameters — <https://wiki.unece.org/download/attachments/265978082/Summary%20UNR154%20LDV%20OBFCM%20technical%20exploration%20-%20WLTP%20Ad-hoc.pdf>
- Toyota Hybrid Diagnosis manual, HV ECU Data List (DRIVE CONDITION, ENG STOP RQST, ENGINE FUEL CUT, MG1 REV, POWER RQST) — <https://gt4.mwp.id.au/Toyota%20Manuals/Mechanics%20Training/Toyota%20-%20Hybrid%20Diagnosis%20-%2019%20Appendix.pdf>
- OBDb/Toyota-Camry (2026 command support data) — <https://github.com/OBDb/Toyota-Camry>
- OBDb/Toyota-RAV4-Hybrid (signalset + recorded response bytes, 2016–2025) — <https://github.com/OBDb/Toyota-RAV4-Hybrid>
- OBDb/Toyota-Corolla-Hybrid — <https://github.com/OBDb/Toyota-Corolla-Hybrid>
- ScanGauge X-Gauge command reference (shipping vendor commands) — <https://www.scangauge.com/support/x-gauge-commands/toyota-lexus-scion/> · <https://www.scangauge.com/x-gauge-commands/corolla-hybrid/>
- Alex C. Peper / Car Code, "Toyota Real Time Powertrain Data" — 364 enhanced Toyota data item **names** (no PIDs, no formulas) — <http://obd-2.com/toypida.htm>

**Community (multi-poster consensus)**

- Gen IV Prius custom PIDs and the `7F 21 11` negative response — <https://priuschat.com/threads/gen-iv-prius-custom-pids-for-torque-app.163271/>
- Gen IV Prius Prime — the SoC PID returning a constant wrong value — <https://priuschat.com/threads/gen-iv-prius-prime-custom-pids-for-torque-app.176099/>
- Corolla TS hybrid — Mode 22 enumeration method and 2021→2024 partial survival — <https://priuschat.com/threads/corolla-ts-hybrid-custom-torque-pids.253928/>
- Gen 2 Prius custom PIDs — <https://priuschat.com/threads/gen2-prius-custom-pids-for-torque-android-app-with-formulas.95370/>
- Gen III Prius custom PIDs — <https://priuschat.com/threads/geniii-prius-custom-pids-for-torque-app.98693/>
- CANBUS PIDs / Gen 2 `21C3` byte map and the `21 42` aux-voltage decode — <https://priuschat.com/threads/canbus-pids.80206/>
- CAN frames `0x348`/`0x3C8` decode — ICE stop / idle / charge request bits and **ICE SPIN MODE** — <https://priuschat.com/threads/decoding-can-messages-0x348-0x3c8-as-described-by-peef.110042/>
- Prius v Mode 21 — the misattributed `7F 21 12` — <https://priuschat.com/threads/prius-v-odb-mode-21.161827/>
- GR Yaris Mode 21 on `7D0` (Mode 21 survives on non-HV ECUs) — <https://www.gr-yaris.co.uk/threads/reverse-engineering-pids.4680/>
- gerdbremer/Prius-gen2-torque-PIDs — <https://github.com/gerdbremer/Prius-gen2-torque-PIDs>
- kutasg/Prius-gen1-torque-PIDs — injector PID non-zero with engine off — <https://github.com/kutasg/Prius-gen1-torque-PIDs>
- EAA-PHEV Prius PHEV TechInfo (Mode 21 bitmask procedure) — <https://www.eaa-phev.org/wiki/Prius_PHEV_TechInfo>
- seandippold.com, "Determining Prius hybrid battery health" — <https://seandippold.com/2017/10/25/determining-health-prius-hybrid-battery/>
- Zan's Projects, Toyota Auris Hybrid Torque PIDs (cross-model transplant failure) — <http://zansprojects.blogspot.com/2018/12/torque-pids-for-toyota-auris-hybrid.html>
- Hybrid Assistant, fuel source per model — <http://hybridassistant.blogspot.com/p/cars.html>
- WiCAN firmware discussion — RAV4 Hybrid fuel level not available as a standard PID — <https://github.com/meatpiHQ/wican-fw/discussions/509>
- HEM Data — "PID $5E … seldom used" — <https://hemdata.com/products/dawn/enews/fuel-economy-obd/>
- Camry XV70 Techstream Data List ("Engine Fuel Rate", no PID) — <https://www.tocamry.com/data_list_active_test-3255.html>
- Lexus ES Data List (A25A-FXS family) — <https://www.lexguide.net/data_list_active_test-3022.html>
- SECONS ToCOM ECU list — XV70 hybrid control exposes 1461 data identifiers — <https://www.obdtester.com/tocom-eculist/toyota/camry_hv_(eur,tmmk)/axvh71_2019_10_2020_10/a25a_fxs>

**Low trust — cited only to be dismissed**

- obdport.com Camry XV70 / XV80 and Corolla pages — templated, uncorroborated Mode 22 catalogue; J1939 truck pinout on a passenger-car page; conflicts with every primary source — <https://obdport.com/vehicles/toyota/camry> · <https://obdport.com/corolla>
- Ruptela vehicle page — identical parameter template across unrelated vehicles, no per-vehicle verification — <https://vehicles.ruptela.com/vehicle/47709>

**Adjacent, non-PID (context only)**

- XV80 China market engines incl. M20F — <https://autowoop.com/cars/toyota/camry/9-generation-xv80-china-market>
- Carista XV80 live data feature list (advertises "EV/Hybrid battery live data", no PIDs) — <https://shop.carista.com/apps/supported-cars/toyota/camry/xv80>
- Pelican, "Toyota Camry Hybrid 2018-2026" marked **"Tester needed"** — confirms the XV80 hybrid PID set is not yet crowdsourced — <https://pelican.clutch.engineering/cars/toyota/camry-hybrid/>

---

## Summary

1. **Standard Mode 01 PIDs on the hybrid ECU `0x7E2` are the only defensible hybrid data** — `0x5B` (SOC) and `0x9A` (HV battery voltage, current, mode) are recorded as answered on a **2026 Camry**, are SAE-defined, and are read-only. Build here.
2. **Mode 21 is almost certainly dead on this car's HV ECU.** Toyota's KWP→UDS migration makes `0x21` a reserved service number, and a Gen 4 Prius HV ECU answers `7F 21 11` (service not supported) to every Mode 21 request. The Gen 2 Prius Mode 21 tables are historically valuable and operationally useless here.
3. **Mode 22 is the current proprietary door**, reachable via `0x7D2` / `747`. Documented PIDs exist (`7A76`, `7A53`, `1093` from ScanGauge; `1F5B`, `1F9A`, `10A1`, `10B2` recorded on a RAV4), but they disagree across platforms and are the archetype of fragile.
4. **Fuel consumption is not derivable with confidence.** `0x5E` is unproven on Toyota hybrids; `0x2F` is absent from the engine ECU; MAF math is biased by fuel cut, enrichment, ethanol and Atkinson-cycle lean running; and the accurate factory path is a powertrain-bus broadcast the device cannot reach. One request to `7E0 01 5E` settles it — do that before designing anything.
5. **Engine RPM ≠ engine running.** MG1 motors the engine with no fuel in *ICE SPIN MODE*, so RPM > 0 with zero fuel flow is a normal hybrid state. Any "engine was on" derivation must be validated against a truth signal.
6. **Nothing is published for the M20F or the XV80.** Every byte offset in Tier B and C is a hypothesis for this car. Treat Tiers B and C as probes, never dependencies, and keep raw bytes so a mis-scaled decode can be recovered.

*Not checked / open risks:* the `unsupported_commands_by_ecu` semantics of the OBDb dataset are undocumented and its `7DF` list is internally inconsistent with its per-ECU entries — the fuel contention rests on that unresolved point. The Corolla 2021 owner's `corollaPIDs.txt` attachment could not be retrieved and its Mode 22 numbers are therefore absent here. No 2025+ Camry Hybrid forum thread with raw PID data was found.
