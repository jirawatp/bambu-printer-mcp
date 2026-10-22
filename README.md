# bambu-printer-mcp

A **mock-by-default TypeScript MCP server prototype** for a shared Bambu Lab printer interface. It prioritizes status, print progress, temperatures and remaining time, with separate family/firmware adapter profiles for **A1, P1, X1, H2 and X2D**.

**By default all telemetry, jobs and camera responses are synthetic.** The only non-mock code is an **X2D LAN read-only telemetry observation** (below): subscribe-only, one exact device, fixed port, verified TLS, bounded, no controls and no camera. **It is implemented and tested offline but admission-blocked: no live session can currently be created**, because the MQTT report topic, protocol version, subscription QoS and X2D firmware/schema are not vendor-verified. Nothing discovers devices, configures a printer, pauses, cancels or prints. Mock tests establish software behavior, not hardware compatibility. This is an independent personal project, unaffiliated with Bambu Lab.

## Run

**Docker is the intended runtime.** Build and launch the restricted stdio container using the [Docker guide](docs/docker.md). It includes MCP host configuration, modest CPU/RAM limits and a container smoke test. The local Node commands below are useful for development.

Use Node.js **22.19 or newer** and npm:

```sh
npm ci --ignore-scripts
npm run check
npm run demo
```

The demo uses the official MCP client to launch the server over stdio, discover tools and query the synthetic X2D fixture. Build before launching the server directly:

```sh
npm run build
node dist/src/cli.js
```

The server waits for an MCP client on stdin; stdout carries only MCP messages. For an MCP host that accepts `mcpServers` configuration, use the absolute path to the compiled entry point:

```json
{
  "mcpServers": {
    "bambu-printer-mock": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/bambu-printer-mcp/dist/src/cli.js"]
    }
  }
}
```

Use the full path to Node if your MCP host does not inherit your shell's PATH. Configure the equivalent local stdio command in hosts using a different configuration format.

## Interface

| MCP tool | Purpose | Default |
| --- | --- | --- |
| `list_printers` | List five synthetic fixtures | Enabled |
| `get_printer_capabilities` | Discover exact mock firmware, state and policy limits | Enabled |
| `get_printer_status` | State, progress %, nozzle/bed °C, seconds remaining | Enabled |
| `prepare_mock_action` | Prepare `pause`, `cancel` or `print` against a fixture | Disabled |
| `execute_mock_action` | Confirm a one-use simulator plan | Disabled |
| `get_mock_camera` | Synthetic camera placeholder | Disabled |

Fixture IDs: `mock-a1`, `mock-p1`, `mock-x1`, `mock-h2`, `mock-x2d`. After contract admission is legitimately opened (it is closed today), the operator-only live flag would append a sixth read-only printer, `live-x2d` (see below). Firmware **`mock-1.0`** and the frame schema are invented test contracts. They do not map to Bambu firmware releases or published MQTT payloads. H2's dual-nozzle fixture represents a scenario, not every H2 variant. Readings are fixed fixtures; progress and remaining time do not advance on a timer. Missing or invalid telemetry stays unknown/null; actual printer support always remains unvalidated.

To exercise simulated controls or camera access, opt in when starting the process:

```sh
node dist/src/cli.js --enable-mock-controls --enable-mock-camera
```

Call `get_printer_capabilities` first. To pause the initial synthetic X2D job, call `prepare_mock_action` with `{"printerId":"mock-x2d","action":"pause"}`; review the returned plan, then call `execute_mock_action` with its `planId` and `confirmed: true`. Plans bind the target, action, job and revision, expire, and can be used only once. `print` accepts only `demo-cube` or `demo-benchy` after the fixture reaches an eligible state. It accepts no file, URL, G-code or arbitrary payload. These checks protect simulator semantics; a client-supplied boolean is **not human authentication** and is insufficient for future hardware control.

## X2D LAN read-only observation (implemented, admission-blocked)

Off by default and **currently refused at the session boundary**: `node dist/src/cli.js --enable-x2d-lan-readonly` and `npm run smoke:x2d-readonly` exit with code 2 and the exact unresolved items before reading any input. Once vendor-verified evidence is recorded and reviewed, they would subscribe to **one** exact X2D (N6, serial prefix `20P`) and expose it as `live-x2d` through the same read-only tools. The flag takes no argument; the host, serial and access code come **only** from inherited environment variables or one JSON line on piped stdin, are kept in memory, and are never accepted as arguments, logged, persisted or returned by any tool. The path is fail-closed:

- **Fail-closed contract admission with no override.** `LanReadOnlySession`, the only public session type, throws `CONTRACT_UNVERIFIED` from its constructor unless every required item in the evidence ledger (`src/lan-contract.ts`: report topic, MQTT version, subscription QoS, installed X2D firmware/schema) carries `official-documentation` or `first-party-source` evidence. Today three are implementation choices and one is unverified, so construction always fails: a valid configuration, an operator-supplied string, an environment variable or an injected channel cannot open it. Admission is a code-path invariant (a pure rule over a frozen ledger), not a privilege boundary: someone who can edit the source can change it. The previous acknowledgement string was removed because it manufactured admission without evidence. The CLI and launcher also check admission before reading any input. The firmware item can only be established from the device itself, so it cannot be cleared by code alone.
- Fixed TCP 8883; the host must be a literal private IPv4 address (no DNS, ranges or scanning); Only the supplied CA roots are trusted (default: the vendor public CA shipped with Studio); system roots are not added, chain and exact serial hostname are checked, and no TLS-relaxation option exists. The CA is operator-supplied trust, not fingerprint-pinned.
- Subscribe-only MQTT: the codec can encode only CONNECT, one literal-topic SUBSCRIBE (QoS 0), PINGREQ and DISCONNECT. There is no PUBLISH encoder, and a runtime gate writes only a buffer that is exactly one frame of a permitted type with its fixed flags and a consistent length (a permitted prefix with a PUBLISH behind it is refused; the gate does not verify minimal remaining-length encoding or every packet body). It never sends `pushall`, so it ignores diff messages rather than guess.
- Bounded and non-retrying: connect/subscribe/keep-alive deadlines, message/byte/packet caps, cancellation, and immediate closure without retry on certificate, authentication, subscription or protocol failure. Elapsed time for deadlines and frame age is the larger of the wall-clock and monotonic deltas, so a wall-clock rollback cannot extend a deadline or make an old frame look fresh. Closing stdin (the MCP host going away) releases the live session. Failure text is a fixed phrase; no peer, payload or error text is forwarded.
- **Retained reports are never telemetry.** A retained PUBLISH is a broker-stored snapshot of unknown age; receipt time is not evidence of freshness. It is counted (`retained-report`, and against the message cap) but never parsed, never replaces live data and never refreshes age; status stays unavailable until a live frame arrives.
- The CA file is read with a descriptor-based, size-bounded regular-file reader: opened non-blocking without following a final symlink, `fstat`-checked as a regular file, then read with a byte cap. FIFOs, devices, directories and growing files are refused instead of hanging or being read without bound.
- Output is a whitelist: state, progress %, bed °C and seconds remaining, with freshness and provenance (`contractVerified`, `firmwareVerified`, `schemaVerified` all `false`). **Nozzle temperatures are not reported (`nozzlesC` is empty)** because the extruder-id mapping is unverified. Stale values are withheld. Pause, cancel, print and camera are reported unsupported and cannot be reached for `live-x2d`.

The operator procedure in [hardware validation](docs/hardware-validation.md) is therefore a prepared, unattempted gate, not a runnable step. The path cannot run in the documented network-disabled Docker container. Observation output would not establish firmware or schema compatibility.

## Quality gate and coverage

`npm run check` (the command CI and the Docker build run) type-checks, builds and runs all tests under [c8](https://github.com/bcoe/c8) 12.0.0, configured in `.c8rc.json`:

- Scope: **every production TypeScript module under `src/`** (`all: true`, measured on compiled `dist/src/**/*.js` and remapped through source maps), including modules no test imports and the CLI entrypoint. Tests, examples and scripts are not production code. There are no coverage ignores or production exclusions.
- Enforced thresholds: **at least 90% statements, branches, functions and lines**, each checked globally across all source (there are deliberately no per-file thresholds). `scripts/coverage-inventory.mjs` additionally fails if any `src/*.ts` file is missing from the report and prints the per-file inventory.
- Commands: `npm run test:coverage` (gate), `npm run test:unit` (tests only, no gate; not a substitute), `npm run typecheck`. Raw reports are written to ignored `coverage/`.
- CI also proves the gate can fail: it reuses the coverage data from the passing run with `npx --no c8 report --lines 101 --reporter=text-summary` (no second suite run) and requires a non-zero exit with the threshold error.
- Reading the numbers: c8 derives statement and line figures from the same V8 block ranges (line counts include non-executable physical lines inside them), so those two coincide and are not independent evidence; branches and functions are the independent measures.

Current measured results, 2026-10-22 (operator-run on a hash-checked 55-file tree, canonical `npm run check`): **228/228 tests passed** and the coverage gate passed with all 15 production `src/` files in the inventory. Global statements 100% (2396/2396), branches 99.42% (869/874), functions 99.27% (137/138) and lines 100% (2396/2396). Every file is at or above 90% on all four metrics, and `safe-file.ts` is 100% on all four. There are no exclusions, and each 90% floor is a global threshold, not a per-file one. The SDK mock demo and the negative gate check (the threshold check that must fail) also passed; the suite was not repeated for them. Offline results like these show that software paths run; they do not establish printer or firmware compatibility, and no real Node TLS/MQTT telemetry from an X2D has been observed. The contract gate stays closed with no override.

Dependency audit status: a fresh production `npm audit` request made for this tree timed out after 180 s (exit code 124, no output). That is neither a pass nor a denial; **no current audit result exists**, and the fresh advisory check is unavailable until remote CI runs. The earlier 210-test snapshot (below) recorded 0 production vulnerabilities on an unchanged lockfile and dependency set; treat that as historical only.

Historical baseline, 2026-10-22 (Node 22.19.0, npm 10.9.3), on the tree before the stdin-EOF, linear decoder buffering, dual-clock, nozzle-shape and offline-spawn follow-up changes: 210/210 tests; statements 100% (2262/2262), branches 99.05% (837/845), functions 99.24% (132/133), lines 100% (2262/2262) across 15 files, with `safe-file.ts` at 89.47% branches. That run also covered a clean locked install, the mock SDK smoke and a production audit with 0 vulnerabilities; the Docker socket was absent, so no container validation was performed. It does not describe the current tree. An earlier measurement (2026-10-21, 79 tests, six modules, 100%) is superseded.

## Design and evidence

```text
MCP stdio tools → policy + action plans → shared printer service
                                      → exact family/firmware adapters
                                      → in-memory mock transports (default)
                                      → optional operator-only X2D LAN subscribe-only session
```

The official X2D manual documents LAN-only Developer Mode, but its scope is firmware 01.01.00.00 and current release notes may differ. Product existence, camera hardware and Developer Mode documentation do not establish this server's hardware compatibility. There is no universal firmware or Developer Mode assumption.

- [Scope and architecture](docs/architecture.md)
- [Capability and compatibility matrix](docs/capability-matrix.md)
- [Official documentation research and source limitations](docs/official-research.md)
- [Security model](SECURITY.md)
- [Docker build, runtime and resource limits](docs/docker.md)
- [Real hardware validation plan](docs/hardware-validation.md)

Tests include adapter/telemetry validation, default-deny controls, stale/expired/replayed plans and an official MCP client/server integration over subprocess stdio. CI runs the mock checks on Node 22 and 24. Dependencies are locked, install scripts are disabled, and the package is marked private to prevent npm publication.

## License decision pending

No project license has been selected. Public visibility does not establish an open-source license. `UNLICENSED` is a publication guard and records the pending decision; dependency licenses remain their respective owners' licenses. Choose an appropriate license with the owner before inviting reuse or distributing a release. No npm package or GitHub release is published by this project.
