# Prototype scope and architecture

## Delivered scope

One MCP stdio interface for five synthetic family fixtures (A1, P1, X1, H2, X2D), with independent exact-firmware adapter profiles and in-memory mock transports. Read operations prioritize state, progress, nozzle/bed temperatures and estimated time remaining. Simulation-only pause/cancel/print and camera interfaces exercise conservative discovery and explicit policy gating.

The one exception is an opt-in **X2D LAN read-only telemetry observation**, implemented and tested offline but currently **admission-blocked** (no live session can be constructed until the wire contract is vendor-verified): a subscribe-only MQTT session to one exact private-IPv4 host over verified TLS on port 8883, exposed as `live-x2d` with unknown nozzle mapping and unverified provenance. No network scanning, cloud login, persisted credential, physical action, settings change, arbitrary command dispatch, file upload, slicing or real video streaming is implemented. Agents and automated tests never connect; only the operator could ever run the live path, and only after admission legitimately opens.

## Modules

| Module | Responsibility |
| --- | --- |
| `src/domain.ts` | Shared types, synthetic protocol constants, provenance and errors |
| `src/adapters.ts` | Exact family/firmware profile selection and bounded nullable normalization |
| `src/mock-transport.ts` | Synthetic frames, revisions and simulator state changes |
| `src/service.ts` | Registry, capability intersection, policies and bound action plans |
| `src/server.ts` | Narrow MCP schemas, tool annotations and bounded responses |
| `src/cli.ts` | Local stdio startup, explicit mock flags and the opt-in `--enable-x2d-lan-readonly` flag; stdio EOF and signals release the live session once |
| `src/lan-contract.ts` | Frozen evidence ledger (official / first-party-source / implementation-choice / unverified), fixed constants and the evidence-only admission rule |
| `src/lan-config.ts` | Ephemeral operator input, private-IPv4/serial/access-code/CA validation; field-only errors |
| `src/mqtt-codec.ts` | Send-restricted MQTT 3.1.1 codec: CONNECT, one SUBSCRIBE, PINGREQ, DISCONNECT only; fragment-tolerant bounded decoder with linear buffering (each byte copied once per packet) |
| `src/x2d-telemetry.ts` | `push_status` whitelist normalizer (state, progress, bed, time remaining); drops diffs and everything else |
| `src/lan-session.ts` | `LanReadOnlySession`, the only public live session: its constructor enforces `requireAdmission()` first, with no option or override |
| `src/lan-engine.ts` | Observation mechanics behind the wrapper (deadlines, caps, freshness over the larger of wall and monotonic elapsed time, retained-report handling, outbound gate (permitted type, flags, length, no trailing bytes), fixed-text failure stages); imported by nothing but `lan-session.ts`, used directly only by offline tests |
| `src/safe-file.ts` | Descriptor-based, size-bounded regular-file reader (non-blocking, no-follow open; refuses FIFOs, devices, directories) |
| `src/lan-tls.ts` | `tls.connect` adapter with fixed verification and error reduction |
| `src/lan-smoke.ts` | Operator smoke launcher: no arguments, stdin/inherited secrets, 60 s / 20 message / 1 MiB caps |

Capabilities are a current intersection of recognized firmware, validated frame/state, adapter support and local policy. They are recomputed before action execution. Model names, product documentation, open ports and firmware version ordering do not grant capabilities. Unsupported firmware is rejected; missing telemetry stays unknown. All output carries synthetic/hardware-untested context.

The synthetic schema deliberately avoids pretending to implement a public Bambu wire protocol. Each family profile can evolve independently; a future real adapter must use a separate, reviewed model/firmware contract and transport. A family-level fixture is not coverage for every variant. The H2 scenario uses two nozzles without asserting that H2S or H2C share that topology. X1E is not covered.

## Command lifecycle

1. Discover the fixture's capabilities under current policy.
2. Prepare one finite simulated action, binding the target, job, revision and allowlisted artifact.
3. Review the plan in the client and submit its reference with explicit confirmation before expiry.
4. Recheck capability, state, target/job binding and revision; consume the plan once.
5. Mutate only in-memory synthetic state and return an updated status.

The plan is not proof of a human decision. Hardware authorization and physical safety require a separate design and validation phase. Camera has a distinct startup permission and returns only synthetic content.

## Validation layers

Unit tests exercise all family profiles, malformed and partial data, exact firmware matching and simulator policies. Stateful tests cover plans and transitions. Integration tests use the official MCP SDK client through a real subprocess stdio channel. CI repeats these software checks on Node 22/24. None of these layers demonstrate behavior on a printer.

The official MCP [TypeScript SDK documentation](https://github.com/modelcontextprotocol/typescript-sdk) was checked on 2026-10-18. This project pins the v2 server/client packages and Zod, keeps stdout reserved for protocol messages and uses the SDK's schema validation rather than a custom JSON-RPC implementation.
