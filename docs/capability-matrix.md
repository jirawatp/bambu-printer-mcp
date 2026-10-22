# Capability matrix

By default this prototype has **no real printer transport**: MCP calls operate on in-memory fixtures. The only exception is a subscribe-only X2D LAN observation (`live-x2d`, four whitelisted telemetry fields) that is implemented but **admission-blocked**: `live-x2d` cannot currently appear in any real run. There is no LAN/cloud discovery, FTP client, camera connection, persisted credential or physical print path. All actual Bambu Lab models and firmware are **hardware-untested**; the live observation's MQTT contract and X2D firmware/schema are unverified.

Vendor documentation and dates are linked in [official research](official-research.md). Documented device features do not certify this implementation.

## Model scope

| Family profile | Documented vendor context | Synthetic mock test target | Actual hardware support |
| --- | --- | --- | --- |
| A1 | A-series LAN/Developer Mode guidance; A1 camera documented | `mock-1.0`, one synthetic nozzle channel | Unavailable; A1 and A1 mini require separate model/firmware validation |
| P1 | P1P/P1S LAN guidance and low-rate camera documented | `mock-1.0`, one synthetic nozzle channel | Unavailable; no universal Developer Mode minimum firmware is asserted |
| X1 | X1/X1C firmware and monitoring guidance documented | `mock-1.0`, one synthetic nozzle channel | Unavailable; X1E is a separate future validation target |
| H2 | H2-series Developer Mode guidance and H2D/H2C documentation | `mock-1.0`, two synthetic nozzle channels | Unavailable; this generic fixture proves neither H2S nor H2C coverage, nozzle topology or protocol compatibility |
| X2D | Official manual documents LAN-only/Developer Mode for 3D printing; firmware caveats apply | `mock-1.0`, two synthetic nozzle channels | Unavailable; first planned read-only hardware validation target |

The sole accepted firmware identifier is the invented **`mock-1.0`**, using the invented `bambu-mcp.synthetic.v1` frame format. It is not a Bambu firmware version or wire format. An unknown firmware identifier or frame protocol disables capabilities; status decoding rejects it. Synthetic channel counts are fixture choices, not family-wide hardware assertions.

## MCP behavior and gates

| Interface | Default behavior | Optional simulator behavior | Hardware behavior |
| --- | --- | --- | --- |
| `list_printers` | Lists five synthetic fixtures | Same | No network discovery; appends `live-x2d` only if a live session exists, which the unverified contract currently prevents |
| `get_printer_capabilities` | Reports exact fixture firmware, provenance, policy and current-state availability | Re-evaluates capabilities per call | No device capability probe |
| `get_printer_status` | Reads synthetic state, progress %, nozzle/bed °C and seconds remaining | Same | `live-x2d` only: state, progress, bed °C, time remaining from the latest fresh, non-retained frame (retained reports are ignored); `nozzlesC` empty; `LIVE_UNAVAILABLE` before the first frame, after any failure or end; values withheld when stale |
| `prepare_mock_action` / `execute_mock_action` | Controls disabled | `--enable-mock-controls` enables simulated pause/cancel/print | Unavailable for `live-x2d` under every policy; no startup flag enables a hardware control |
| `get_mock_camera` | Camera disabled | `--enable-mock-camera` returns a fixed synthetic SVG | Unavailable for `live-x2d`; no image from a real camera |

`live-x2d` capabilities always report `firmwareSupported: false`, `fixtureNozzleCount: 0` (meaning no nozzle channel is reported, not that the printer has no nozzles) and an empty `nozzlesC` array in status (no nozzle reading is extracted and the count is unknown, never inferred as two slots), pause/cancel/print/camera unsupported with fixed reasons, and status supported only while telemetry is fresh. Its provenance records `transport: lan-readonly`, `hardwareValidated`, `contractVerified`, `firmwareVerified` and `schemaVerified` all `false`, `nozzleMapping: unknown`, freshness and age. The staleness threshold (60 s) is provisional because no X2D update interval has been measured.

Status normalization returns `null` and warnings for absent, invalid or out-of-range values; it does not invent readings. A valid protocol permits reading partial telemetry. Mock mutations require complete, consistent telemetry and job binding. Temperature validation bounds are fixture input checks, not physical safety limits.

With mock controls enabled, pause requires `printing`; cancel requires `printing` or `paused`; print requires an inactive fixture and one of the built-in identifiers `demo-cube` or `demo-benchy`. No tool accepts raw commands, G-code, upload paths or URLs. An action plan binds the target, job and revision, expires after 30 seconds by default and is consumed on every execution attempt. Execution checks confirmation, policy, state, expiry and revision again; concurrent/replayed or changed plans fail.

The `confirmed` argument is a client assertion. It does **not** authenticate a human, grant device authorization or make this workflow sufficient for physical control. The mock does not simulate a real network, certificate validation, device acknowledgements or telemetry age. Hardware freshness/disconnect behavior is future work described in [hardware validation](hardware-validation.md).
