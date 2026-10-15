# Glossary

Domain vocabulary for this project. Deliberately free of implementation detail — no part numbers, no message identifiers, no file formats.

## Vehicle and bus

**Diagnosis bus** — the CAN segment running between the OBD2 connector and the gateway ECU. The only bus reachable from the connector, and the reason passive listening at the port yields almost nothing.

**Powertrain bus** — the vehicle's internal network, where engine, brake, and body state are broadcast continuously. Not reachable from the OBD2 connector; a camera-connector tap is the only way in.

**Gateway ECU** — the vehicle's central gateway, sitting between the OBD2 connector and the internal networks. It answers diagnostic requests and does not relay internal broadcasts out to the connector.

**Tap point** — the physical place on the vehicle where the device reads traffic. Currently the OBD2 connector; a camera-connector tap is a possible later upgrade.

**Request** — a message that asks a vehicle ECU for data. Permitted.

**Command** — a message that changes vehicle state: clearing codes, actuating, coding, configuring. Never permitted, under any circumstance. An ADR records this.

**Polling** — repeatedly asking an ECU for a value, as opposed to listening for broadcasts the vehicle sends on its own.

**Signal inventory** — the set of quantities *this specific vehicle* has been confirmed to answer for. Established by measurement on the car, never by what the standard says should be available.

## Device behaviour

**Trip** — one continuous period of vehicle use as the device defines it: from the moment the bus wakes until five minutes of bus silence. The device has no ignition signal of its own; silence is the only evidence of ignition state available to it.

**Ignition-off window** — the five minutes of bus silence that ends a trip, during which the device keeps its access point up so a human can export. One interval doing two jobs: trip boundary and export opportunity.

**Rollup** — an aggregated record summarising an interval, as distinct from a sample of it.

**Derivation** — computing figures on the device itself rather than downstream. Once derived, the underlying samples are gone.

## Data movement

**Batch** — the set of records offered for export in a single action.

**Export** — the manual act of moving records off the device and into the owner's database, initiated by a human from the dashboard inside the ignition-off window.

**Confirmation** — the response telling the device that an export succeeded. Records are deleted only after confirmation, never on the attempt.
