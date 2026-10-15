# Tapping the Toyota LKAS camera connector without cutting wires

**Question.** Can the forward-recognition-camera (LKAS camera) connector behind the
rear-view mirror of a 2026 Toyota Camry (XV80, TNGA-K, 2.0L M20F hybrid, GAC Toyota
China market) be tapped **plug-and-play, with no wire cutting**, to read brake-pedal
and turn-signal state that standard OBD2 PIDs do not expose?

**Researched:** 2026-10-14. Confidence ratings are per-claim: **High** (primary source /
official docs), **Medium** (credible community source or strong inference from a
documented sibling platform), **Low** (single anecdote or indirect inference),
**Not documented** (no source found — stated as such rather than guessed).

---

## Bottom line

**A no-cut tap is mechanically plausible but you should not do it on this car.**

The interesting finding is that the usual reason for refusing — "you'd be cutting
wires" — is not actually the blocker. The blockers are different and worse:

1. **comma.ai, the only vendor that sells these harnesses, explicitly lists the 2025
   Camry as `Not compatible`** and does not sell a harness for it. Confidence: **High.**
2. **There is no off-the-shelf harness for the XV80's camera connector**, and the
   connector's type/pin count/part numbers are **not publicly documented** for the
   XV80. Confidence: **High** (absence of evidence, stated plainly).
3. **The TSS 3.0 camera bus is believed to be CAN-FD** (community inference from the
   2023 TSS 3.0 Corolla), and **the ESP32-S3 cannot receive CAN-FD frames at all** —
   Espressif confirms the TWAI peripheral "is not compatible with FD format frames and
   will interpret such frames as errors." If XV80 is CAN-FD, the ESP32-S3 is the wrong
   radio, independent of any harness question. Confidence: **High** on the ESP32-S3
   limitation, **Low** on the XV80-is-CAN-FD inference.
4. **The XV80 is TSK/SecOC (Toyota Security Key)** — a 2022+ Toyota that the community
   has not cracked. Whether the brake/blinker payloads on that bus are still readable
   plaintext (standard SecOC) or are encrypted is **not publicly settled**; the
   community doc uses the word "ciphertext" for these cars. Confidence: **Low.**
5. **The car will complain.** Disconnecting the forward recognition camera is a
   documented Toyota fault condition: PCS warning light, multi-information-display
   messages, stored DTCs, and disabled PCS/LDA/LTA. Confidence: **High.**

The marginal benefit (two signals) is small, the car is under warranty, and the
device cannot read the bus even if the connector were identified. **Ship without
brake and blinker data**, and if you want a cheaper shot at it, the OBD-port avenue
in "Alternatives" is where the remaining optimism should go.

---

## Scope caveats

- **GAC Toyota China market.** Every comma.ai/openpilot support statement below
  describes the **US market**. Chinese-market Toyotas are separately known to behave
  differently — e.g. the community docs record a China-market 2025 Lexus ES with
  TSK/SecOC checksum failures, and note "Do not generalize this finding to all 2025
  Lexus ES vehicles." <https://github.com/optskug/docs> There is **no** data at all on
  the China-market XV80 Camry's camera connector. Treat the China-market variant as
  strictly less documented than the US one.
- The 2026 "Sport Lite" trim is a GAC China trim. No source consulted mentions this
  trim name; the US-market trim names (LE/SE/XLE/XSE/Nightshade) are the only ones
  with parts documentation.

---

## 1. Off-the-shelf harnesses

### What comma.ai actually sells

| Item | Price | Notes |
|---|---|---|
| car harness (harness box + connector + wiring) | **$99** | <https://comma.ai/shop/car-harness> |
| harness connector only (wires + connector, no box) | **$50** | <https://comma.ai/shop/harness-connector> |

The connector is chosen from a dropdown. The full connector list on the Shopify
product page includes **`Toyota A`** and **`Toyota B`**:
<https://shop.comma.ai/products/comma-car-harness>. Nobody sells a `Toyota C`.

- **Toyota A** is the harness used for *every* Toyota comma currently supports,
  including **Camry 2018-20** and **Camry 2021-24**:
  <https://www.comma.ai/shop/comma-four?harness=Toyota+Highlander+2020-23>
  The community docs state "all harnesses for pre-existing and non-TSK/SecOC supported
  Toyota vehicles are Toyota Harness A."
- **Toyota B** exists because Toyota changed the connector on TSS 3.0 cars. Tracking
  issue: <https://github.com/commaai/openpilot/issues/28402> ("which car is this for?
  2023 Toyota Corolla Hybrid (vehicles made at Japan plant)"). Community notes record
  the change directly: "it seems Toyota has changed the connectors. This one has 16
  'pins' (not all populated), compared to the older 12 'pin' connector," and that the
  16-pin plug "is noted to be physically identical to the harness plug used for Subaru
  vehicles." <https://github.com/u2kstudio/comma-3x-toyota-master> (mirror of the
  optskug history log). A secondary summary states Harness B is the **16-pin** part and
  Harness A the **12-pin** part: <https://deepwiki.com/optskug/docs/3.2-potentially-compatible-vehicles-(yellow-and-orange)>.
- **Third-party copies exist.** konik.ai sells "Toyota/Lexus Harness cable. Type A and
  Type B." from **€25.99**: <https://konik.ai/shop/harness-for-toyota-lexus/>. Made in
  EU, harness box sold separately. No claim of XV80 fitment.

### Does any of them fit the 2026 Camry / XV80?

**No.** Confidence: **High.**

- comma.ai's own vehicle list does not contain a 2025 or 2026 Camry harness option at
  all; the newest Camry entries are `Camry 2021-24 Harness: Toyota A`.
- The machine-readable compatibility table is unambiguous. `docs/CARS.md` in
  `commaai/opendbc` lists:

  ```
  |Toyota|Camry 2018-20|All|Upstream|
  |Toyota|Camry 2021-24|All|Upstream|
  |Toyota|Camry 2025|All|Not compatible|
  ```

  <https://github.com/commaai/opendbc/blob/master/docs/CARS.md>

  The "Not compatible" entry links to the section headed **CAN Bus Security**:

  > "Vehicles with CAN security measures, such as AUTOSAR Secure Onboard Communication
  > (SecOC) are not usable with openpilot unless the owner can recover the message
  > signing key and implement CAN message signing. Examples include certain newer
  > Toyota, and the GM Global B platform."

  **Camry 2026 is not listed at all.**

- Even where a harness exists, it is **not a passive tap**. The harness box contains a
  relay that *interrupts* the camera bus: "An integrated relay ensures that you can
  remove the c3x without your car giving you an error message ... Internally, the
  camera's can bus is separated from the rest of the car."
  <https://github.com/commaai/hardware/blob/master/harness/README.md> That design is
  built around openpilot *replacing* camera messages. It is not what a read-only
  telemetry sniffer needs, and comma's README warns: "The harness box must be connected
  to the harness, otherwise your car will display error messages."

**Cost to buy in:** $99 for the harness (+$999 for the comma device it is designed to
feed). Neither is a path to a read-only ESP32 tap, and neither is offered for this car.

---

## 2. Building one by hand

### The 12-pin (Toyota A generation) connector — parts ARE documented

If the car used the older 12-pin camera connector, a plug-and-play Y is buildable from
catalogue parts. `cydia2020/toyota-dsu-reroute-harness` publishes, for the comma Toyota
A camera connector: <https://github.com/cydia2020/toyota-dsu-reroute-harness>

| Part | TE Connectivity P/N |
|---|---|
| Camera plug (female camera connector) | `1318774-1` |
| Camera plug female pin receptacles (×10) | `1123343-1` |
| Camera receptacle (male camera connector) | `1565894-1` |
| Camera receptacle male pin tabs (×10) | `1376109-1` |

Confidence: **Medium** — a single community repo, but it is the repo the comma
community points at and it names exact catalogue numbers.

### The 16-pin (Toyota B generation) connector — parts are NOT documented

For the 16-pin connector used by TSS 3.0 Toyotas I found **no published housing or
terminal part numbers**. Confidence: **Not documented.**

The only concrete evidence that mating halves exist at all is a Toyota GR Corolla
forum thread where a member bought male and female 16-pin front-camera pigtails
"from alibaba" specifically so he could "splice the two ends then split out power
without modifying the original connector." <https://www.grcorollaforum.com/threads/16-pin-connector-for-front-camera.3921/>
The thread contains **no part numbers**, and the seller did not publish them.

If you wanted to identify the series yourself, the realistic route is to unplug the
camera on a car you own and read the moulded housing markings (Toyota `90980-xxxxx`
and/or a Sumitomo/Yazaki 4+4-digit number), then search a connector distributor. Note
that none of the Toyota `90980-*` parts I surfaced in this research correspond to the
TSS 3.0 camera connector — the ones I found (`90980-12495` 4-way video, `90980-12382`
6-way, `90980-12A59` 6-way Land Cruiser front camera) are all *rear/park-assist video*
connectors, a different circuit entirely. Do not confuse them with the ADAS camera.
<https://www.bmotorsports.com/shop/product_info.php/products_id/4067>

Confidence: **High** that the TSS 3.0 camera connector part numbers are unpublished.

---

## 3. What is physically behind the mirror on a 2026 Camry

### Combined module, not a DSU

- The XV80 Camry has a single **Forward Recognition Camera**. Genuine Toyota part
  numbers for the 2025 Camry include `8646C-06090` (listed as fitting "2025 Toyota
  Camry LE, SE, XLE, XSE, 4 Cyl 2.5L FULL HYBRID") and `8646C-06112`. Both are
  described as "Lane Assist Cmra" / "Forward Recognition Camera."
  <https://www.toyotapartsnow.com/oem/toyota~camera-forward-reco~8646c-06090>
  <https://autoparts.toyota.com/products/product/camera-forward-recognition-8646c06112>
  Confidence: **High.**
- **There is no separate DSU.** The openpilot wiki states it flatly: "Unfortunately,
  Camrys DO NOT have DSUs, thus can not have a SDSU added, thus they will only work in
  lateral mode only." <https://github-wiki-see.page/m/commaai/openpilot/wiki/Smart-DSU>
  The DSU ("Driving Support Unit", controls AEB/longitudinal) was a **TSS-P era** part;
  on TSS 2.0+ Toyota folded camera/control functions together and the Camry line has
  been DSU-less since at least the 2018 XV70. So the answer to "separate camera, DSU, or
  combined module" is: **combined forward recognition camera**, no DSU. Confidence:
  **High** for the Camry line generally; **Medium** as applied specifically to XV80
  (no XV80-specific teardown found).
- TSS 3.0 also adds an optional **driver monitor camera**, and the system still uses a
  separate **front radar sensor** behind the grille. The 2026 Camry owner's manual
  supplement for driving support systems lists: "Front radar sensor, Front camera,
  Front side radar sensors, Driver monitor camera." 25TC03 campaign documents confirm
  the TSS 3.0 camera is a flashable, individually replaceable ECU (`8646C-0A040` for
  Corolla Cross, `8646C-08022` for Sienna HV, etc.).
  <https://static.oemdtc.com/NHTSA-PDFs/MC-11018344-0001.pdf>
  Confidence: **High.**

### Which CAN buses are at that connector — and at what pins

**For the XV80 specifically: not documented.** Confidence: **Not documented.** I found
no XV80 camera-connector pinout, no XV80 CAN log, and no XV80 wiring diagram excerpt
in the public record.

What *is* documented is the neighbouring (XV70) platform and the older TSS-P cars:

- **XV70 Camry (TSS 2.5+), forward recognition camera connector** — the service manual
  labels it connector `V6` (before Nov 2021 production) / `V21` (from Nov 2021), and
  gives: `CA1P` on pin **5**, `CA1N` on pin **11** (a CAN pair, measured 54–69 Ω across
  the disconnected pair, i.e. a terminated branch line), `GND` on pin **10**, `IGB`
  (ignition power) on pin **7**, `HTR` on pin **1**.
  <https://www.tocamry.com/front_camera_module_communication_stop_mode-3879.html>
  Note this is **one** CAN pair on that connector.
- **TSS-P era, comma's own port guide** — at the FRC connector the car exposes **two**
  buses: "CAN bus 0 will from now on be referred to as the Powertrain CAN Bus: it
  contains messages related to vehicle speed, steering, acceleration etc… CAN bus 1
  will be referred to as the Radar CAN Bus." <https://blog.comma.ai/openpilot-port-guide-for-toyota-models/>
  That is the historical basis for the claim that **powertrain CAN is reachable at the
  camera** — and it is why comma's whole Toyota harness strategy exists. Confidence:
  **High for TSS-P**, **Medium** as a generalisation.
- **Tundra (newer, 12-pin W9)** is documented with a *second* CAN pair in addition to
  the camera branch: `CA1P` pin 5 / `CA1N` pin 11 **and** `CANH` pin 6 / `CANL` pin 12,
  plus `IGB` pin 7, `GND` pin 10, `HTR` pin 1, `BZ` pin 8.
  <https://www.ttundra.com/1250/terminals_of_ecu.html> Confidence: **High** for Tundra,
  but Tundra is not XV80.
- **The TSS 3.0 connector is 16-pin and likely CAN-FD.** The community note for the
  2023 US-made TSS 3.0 Corolla: "Likely requires a C3X as it's probably that it uses
  CAN-FD." <https://github.com/optskug/docs> Confidence: **Low** as applied to XV80.

**Does that buy brake and blinker?** opendbc already contains exactly these signals for
TNGA-K — the platform under the XV80:

```
# commaai/opendbc .../toyota_tnga_k_pt_generated.dbc
BO_ 560 BRAKE_2: 7 XXX
 SG_ BRAKE_PRESSED : 26|1@0+ (1,0) [0|1] "" XXX
BO_ 1556 BLINKERS_STATE: 8 XXX
 SG_ TURN_SIGNALS : 29|2@0+ (1,0) [0|3] "" XXX
 SG_ HAZARD_LIGHT : 27|1@0+ (1,0) [0|1] "" XXX
VAL_ 1556 TURN_SIGNALS 3 "none" 2 "right" 1 "left";
```

<https://github.com/commaai/opendbc/blob/master/opendbc/dbc/toyota_tnga_k_pt_generated.dbc>
</br>Also present in `toyota_new_mc_pt_generated.dbc` and (as `STEERING_LEVERS`) in
`toyota_nodsu_pt_generated.dbc`, with identical bit fields — so this is a stable,
long-lived Toyota message pair, not a one-off. openpilot itself consumes
`TURN_SIGNALS` from `STEERING_LEVERS` on the powertrain bus to drive its own blinker
logic. Confidence: **High** that the signals exist as DBC definitions on Toyota
powertrain CAN; **Medium** that they are broadcast unencrypted on the XV80.

So the answer to "what signal set does it buy" is precisely two things:
**`BRAKE_PRESSED` (0x230/560, bit 26)** and **`TURN_SIGNALS` (0x614/1556, bits 29–30)**,
plus `HAZARD_LIGHT` in the same frame — *if* that bus is present at the connector in
the clear. Neither of those is a standard OBD2 PID, which matches the project premise.

---

## 4. What the car does when the camera is unplugged / an adapter sits in its place

This is the genuinely risky part, and it is well documented. Confidence: **High**
(Toyota service manuals are the primary source here).

**Toyota treats a disconnected forward recognition camera as a fault condition**
("Front Camera Module Communication Stop Mode", CAN-bus U-series DTCs):

> "Forward recognition camera branch line or connector / Power source circuit of
> forward recognition camera / Forward recognition camera ground circuit / Forward
> recognition camera"
> — trouble areas for "Front Camera Module Communication Stop Mode"
> <https://www.tocamry.com/front_camera_module_communication_stop_mode-3879.html>

**Driver-visible symptoms**, from the pre-collision-system fail-safe tables:

| Message | Meaning |
|---|---|
| "Pre-Collision System Malfunction Visit Your Dealer" | PCS malfunctioning, **DTC stored**, master warning illuminated, PCS light blinking |
| "Front Camera Unavailable" | abnormal camera voltage / camera recognition stopped / temperature out of range; **PCS light illuminates** |
| "Front Camera Unavailable See Owner's Manual" / "Remove Debris On Windshield" | camera or windscreen dirty/fogged in the camera's field of view |

<https://www.ttundra.com/2228/fail_safe_chart.html>
<https://www.lexusrx.net/3552/diagnosis_system.html>
The fail-safe chart is explicit that on these conditions "the pre-collision system will
be disabled."

**Corroboration from comma's users.** A RAV4 Hybrid driver with a CAN-bus failure at
the harness reported: "my 2021 Rav4 Hybrid displayed several warnings about headlight
system malfunction, LTA malfunction, Pre-collision system on the dash." The comma
developer response confirms the mechanism: "The vehicle warnings you saw fit the same
picture since those systems all communicate over the same wiring the device taps into."
<https://community.sunnypilot.ai/t/sudden-unrecognized-vehicle-variant-dashcam-mode/6554>

**Corroboration from comma's own docs.** "The harness box must be connected to the
harness, otherwise your car will display error messages."
<https://github.com/commaai/hardware/blob/master/harness/README.md>

**And a recalibration consequence.** ADAS repair guidance for the XV70/XV80 Camry
states "[Toyota requires front camera recalibration after] camera disconnection or
reconnection" <https://nexauto.us/toyota-camry-windshield-replacement-safety-sense-calibration/>.
Confidence: **Medium** (aftermarket ADAS shop, but consistent with Toyota's "Front
Recognition Camera Optical Axis Not Adjusted" vehicle-control-history code X2014,
<https://www.tocamry.com/vehicle_control_history-3718.html>).

**Practical summary.** If the camera is left talking through a good adapter, the car
should behave normally — CAN is a multi-drop bus and the camera never knows it has a
listener. If the adapter is poor, intermittent, or the camera ends up not
communicating, expect: warning lights, chimes, stored DTCs in the camera/PCS modules,
temporarily or persistently disabled PCS/LDA/LTA, and a service visit. On a car under
warranty, stored DTCs referencing the ADAS camera are exactly the kind of fingerprint
that turns a warranty conversation bad. A second consideration: TSS 3.0 is heavily
camera-dependent — special service campaign 25TC03 exists because a *software* fault in
that camera can brick PCS (and Toyota replaces the camera) —
<https://dot.report/bulletins/11019348>.

---

## 5. Camry-specific tap reports (XV80 / MY2026)

**There are none.** Confidence: **High** — this is a documented absence, not an
inference.

What I searched for and did not find:

- No comma.ai/openpilot report, log, forum post, or issue for a **2025 or 2026 Camry**
  with a comma device installed. The vehicle simply is not in the supported list, and
  the community "not hacked" list names the model without any user reports attached:
  `* 2025+ Camry[^3]` sits under **"🔴 Not hacked and can't run openpilot"** —
  <https://github.com/optskug/docs>. That section's header explains the category:
  "Introduced in 2022+ with TSK/SecOC but it's strongly suspected that they have an
  updated chip that precludes the existing exploits from dumping the key." Confidence:
  **High** that the model is listed; **High** that it is unsolved.
- No XV80 CAN-bus tap, sniff, or reverse-engineering write-up of any kind.

What *does* exist for the 2025 Camry is **power-only** tapping behind the mirror, and it
is worth being precise about, because it is easy to mistake for a CAN tap:

- The **mirror** connector is 12-pin with only 8 populated on a 2025 Camry XLE
  (<https://www.toyotanation.com/threads/wiring-dashcam-into-shroud-behind-rearview-mirror-2025-camry-xle.1791342/>).
  That is auto-dim/HomeLink power, not CAN.
- The **dashcam pre-wire** is a separate 5-pin switched-12V connector hidden in a black
  cloth sleeve above the headliner near the overhead console; Toyota part
  `PT949-03210-C0`, install write-up:
  <https://www.toyotanation.com/threads/2025-camry-xle-oem-dashcam-installation.1808895/>
  Confirms: "No. It is only integrated to the power that I am aware of."
- Separately, a "12-pin, 8 populated" adapter was being marketed as 2025-Camry-compatible
  by a dashcam seller, unverified by the buyer. Treat third-party "compatible with 2025
  Camry" 12-pin claims with suspicion.

Confidence: **High** on the above, **High** that none of it is a CAN tap.

---

## Alternatives worth trying before any camera tap

In rough order of cost and risk:

1. **Do nothing.** Ship the device without brake/blinker. This is the recommended
   outcome. The camera tap buys two signals at the cost of a warranty conversation and
   hardware that may not even be able to read the bus.
2. **Probe the OBD-II port properly.** A telematics vendor lists the **XV80 Camry
   (2025+)** as supported via plain **"OBD CANBus"** connection, with `CAN brake switch`
   among the enabled parameters: <https://vehicles.ruptela.com/vehicle/47709>.
   Confidence: **Low–Medium** — vendor parameter tables are often generic across a
   model family and the "Supported" column could not be confirmed. But it is the single
   cheapest thing to check: put a passive sniffer on OBD pins 6/14 on your own car and
   look for the `0x230`/`0x614` IDs above. Gateway behaviour differs between platforms —
   the eTNGA (bZ4X) reverse-engineering notes state plainly that "The OBD bus only sees
   a subset" of internal buses and "Internal vehicle CAN buses beyond what's bridged to
   OBD-II by the Central Gateway" are out of scope
   (<https://github.com/kezarjg/etnga-obd>) — so this may well fail, but it costs one
   evening and touches nothing.
3. Only if 1 and 2 both fail: identify the XV80 camera connector empirically on your own
   car, and confirm the bus is classic CAN (not CAN-FD) with a scope or a CAN-FD-capable
   adapter *before* buying any ESP32 hardware.

---

## Verdict, by claim

| Claim | Verdict | Confidence |
|---|---|---|
| comma sells Toyota A (12-pin) and Toyota B (16-pin) harnesses, $99 | True | High |
| Any of them fits a 2025/2026 Camry | False — comma lists `Camry 2025 \| Not compatible` (CAN bus security); 2026 unlisted | High |
| No-cut is possible *in principle* on this connector | Likely true mechanically, but unproven for XV80 | Low |
| XV80 camera connector part numbers are published | False — not documented | High |
| Toyota A (12-pin) generation connector parts are published (TE P/Ns above) | True, but that generation is not this car | Medium |
| XV80 has a separate DSU | False — Camry has no DSU; combined forward recognition camera | High |
| Powertrain CAN (brake/turn) is present at the XV80 camera connector | Not documented | Not documented |
| `BRAKE_PRESSED` and `TURN_SIGNALS` exist on TNGA-K powertrain CAN | True (opendbc DBC) | High |
| ESP32-S3 can read these | Only if the bus is classic CAN; S3 cannot do CAN-FD | High on the S3 limit |
| Unplugging the camera causes warnings/DTCs/disabled PCS | True | High |
| Anyone has tapped an XV80 Camry | No reports exist | High |
| **Do this on a 2026 car under warranty?** | **No** | High |

---

## Sources

Primary / official:

- comma.ai openpilot compatibility table — <https://github.com/commaai/opendbc/blob/master/docs/CARS.md>
- comma.ai vehicle list — <https://comma.ai/vehicles>
- comma.ai car harness — <https://comma.ai/shop/car-harness> · <https://shop.comma.ai/products/comma-car-harness>
- comma.ai harness connector — <https://comma.ai/shop/harness-connector>
- comma.ai harness docs — <https://github.com/commaai/hardware/blob/master/harness/README.md>
- comma.ai openpilot port guide (Toyota) — <https://blog.comma.ai/openpilot-port-guide-for-toyota-models/>
- openpilot wiki, Toyota/Lexus — <https://github.com/commaai/openpilot/wiki/Toyota-Lexus>
- openpilot wiki, Smart DSU (Camry has no DSU) — <https://github-wiki-see.page/m/commaai/openpilot/wiki/Smart-DSU>
- Toyota B harness issue — <https://github.com/commaai/openpilot/issues/28402>
- opendbc TNGA-K DBC (BRAKE_2, BLINKERS_STATE) — <https://github.com/commaai/opendbc/blob/master/opendbc/dbc/toyota_tnga_k_pt_generated.dbc>
- Espressif ESP-IDF, TWAI on ESP32-S3 (no CAN-FD) — <https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-reference/peripherals/twai.html>
- Espressif ESP-FAQ, "Does ESP32-S3 support CAN-FD?" — <https://docs.espressif.com/projects/esp-faq/en/latest/software-framework/peripherals/twai.html>
- Toyota 2026 Camry driving support systems owner's manual excerpt — <https://www.toyota.com/content/dam/toyotaowners/dom/add-driver-pdfs/2026/camry-hv/MY26_Camry_OM_Excerpt_for_Driving_Support_Systems_D2_ML_0801.pdf>
- Toyota Special Service Campaign 25TC03 (TSS 3.0 camera) — <https://static.oemdtc.com/NHTSA-PDFs/MC-11018344-0001.pdf>
- Toyota service manual, pre-collision fail-safe chart — <https://www.ttundra.com/2228/fail_safe_chart.html>
- Toyota service manual, Lexus RX pre-collision diagnosis — <https://www.lexusrx.net/3552/diagnosis_system.html>
- Toyota Camry XV70 front camera module communication stop mode (connector V6/V21 pins) — <https://www.tocamry.com/front_camera_module_communication_stop_mode-3879.html>
- Toyota Camry XV70 vehicle control history X2014 — <https://www.tocamry.com/vehicle_control_history-3718.html>
- Toyota Tundra forward recognition camera terminals (W9 pins) — <https://www.ttundra.com/1250/terminals_of_ecu.html>
- 2025 Camry forward recognition camera P/N 8646C-06090 — <https://www.toyotapartsnow.com/oem/toyota~camera-forward-reco~8646c-06090>

Community / secondary:

- optskug/docs — TSK/SecOC status by vehicle (incl. `2025+ Camry`) — <https://github.com/optskug/docs>
- optskug docs mirror with connector history (16-pin vs 12-pin) — <https://github.com/u2kstudio/comma-3x-toyota-master>
- DeepWiki summary of the yellow/orange vehicle lists — <https://deepwiki.com/optskug/docs/3.2-potentially-compatible-vehicles-(yellow-and-orange)>
- cydia2020, Toyota DSU reroute harness (TE connector part numbers) — <https://github.com/cydia2020/toyota-dsu-reroute-harness>
- konik.ai Toyota/Lexus harness — <https://konik.ai/shop/harness-for-toyota-lexus/>
- sunnypilot community, CAN failure presenting as warning lights — <https://community.sunnypilot.ai/t/sudden-unrecognized-vehicle-variant-dashcam-mode/6554>
- Toyota Nation, 2025 Camry mirror-shroud 12-pin connector — <https://www.toyotanation.com/threads/wiring-dashcam-into-shroud-behind-rearview-mirror-2025-camry-xle.1791342/>
- Toyota Nation, 2025 Camry OEM dashcam pre-wire install — <https://www.toyotanation.com/threads/2025-camry-xle-oem-dashcam-installation.1808895/>
- GR Corolla forum, 16-pin front camera pigtails (no P/Ns) — <https://www.grcorollaforum.com/threads/16-pin-connector-for-front-camera.3921/>
- Ruptela supported vehicle, Camry 2025+ XV80 via OBD — <https://vehicles.ruptela.com/vehicle/47709>
- etnga-obd, OBD-II surface on eTNGA (gateway limits) — <https://github.com/kezarjg/etnga-obd>
- NEX Automotive, Camry ADAS recalibration triggers — <https://nexauto.us/toyota-camry-windshield-replacement-safety-sense-calibration/>
- Ballenger Motorsports, Sumitomo TS 025 video connector (Toyota 90980-12495) — <https://www.bmotorsports.com/shop/product_info.php/products_id/4067>
