# Prototype scope and architecture

## Delivered scope

One MCP stdio interface for five synthetic family fixtures (A1, P1, X1, H2, X2D), with independent exact-firmware adapter profiles and in-memory mock transports. Read operations prioritize state, progress, nozzle/bed temperatures and estimated time remaining. Simulation-only pause/cancel/print and camera interfaces exercise conservative discovery and explicit policy gating.

No printer connection, actual firmware adapter, network scanning, cloud login, device credential, physical action, settings change, arbitrary command dispatch, file upload, slicing or real video streaming is implemented. The owner has not authorized live hardware testing in this task.

## Modules

| Module | Responsibility |
| --- | --- |
| `src/domain.ts` | Shared types, synthetic protocol constants, provenance and errors |
| `src/adapters.ts` | Exact family/firmware profile selection and bounded nullable normalization |
| `src/mock-transport.ts` | Synthetic frames, revisions and simulator state changes |
| `src/service.ts` | Registry, capability intersection, policies and bound action plans |
| `src/server.ts` | Narrow MCP schemas, tool annotations and bounded responses |
| `src/cli.ts` | Local stdio startup and explicit mock-only flags |

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
