# bambu-printer-mcp

A **mock-only TypeScript MCP server prototype** for a shared Bambu Lab printer interface. It prioritizes status, print progress, temperatures and remaining time, with separate family/firmware adapter profiles for **A1, P1, X1, H2 and X2D**.

**No real printer transport exists in this version.** All telemetry, jobs and camera responses are synthetic. No device is discovered, connected, configured, paused, cancelled or physically printed by this code. Mock tests establish software behavior, not hardware compatibility. This is an independent personal project, unaffiliated with Bambu Lab, Proofestra or Agensi products.

## Run

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

Fixture IDs: `mock-a1`, `mock-p1`, `mock-x1`, `mock-h2`, `mock-x2d`. Firmware **`mock-1.0`** and the frame schema are invented test contracts. They do not map to Bambu firmware releases or published MQTT payloads. H2's dual-nozzle fixture represents a scenario, not every H2 variant. Readings are fixed fixtures; progress and remaining time do not advance on a timer. Missing or invalid telemetry stays unknown/null; actual printer support always remains unvalidated.

To exercise simulated controls or camera access, opt in when starting the process:

```sh
node dist/src/cli.js --enable-mock-controls --enable-mock-camera
```

Call `get_printer_capabilities` first. To pause the initial synthetic X2D job, call `prepare_mock_action` with `{"printerId":"mock-x2d","action":"pause"}`; review the returned plan, then call `execute_mock_action` with its `planId` and `confirmed: true`. Plans bind the target, action, job and revision, expire, and can be used only once. `print` accepts only `demo-cube` or `demo-benchy` after the fixture reaches an eligible state. It accepts no file, URL, G-code or arbitrary payload. These checks protect simulator semantics; a client-supplied boolean is **not human authentication** and is insufficient for future hardware control.

## Design and evidence

```text
MCP stdio tools → policy + action plans → shared printer service
                                      → exact family/firmware adapters
                                      → in-memory mock transports only
```

The official X2D manual documents LAN-only Developer Mode, but its scope is firmware 01.01.00.00 and current release notes may differ. Product existence, camera hardware and Developer Mode documentation do not establish this server's hardware compatibility. There is no universal firmware or Developer Mode assumption.

- [Scope and architecture](docs/architecture.md)
- [Capability and compatibility matrix](docs/capability-matrix.md)
- [Official documentation research and source limitations](docs/official-research.md)
- [Security model](SECURITY.md)
- [Real hardware validation plan](docs/hardware-validation.md)

Tests include adapter/telemetry validation, default-deny controls, stale/expired/replayed plans and an official MCP client/server integration over subprocess stdio. CI runs the mock checks on Node 22 and 24. Dependencies are locked, install scripts are disabled, and the package is marked private to prevent npm publication.

## License decision pending

No project license has been selected. Public visibility does not establish an open-source license. `UNLICENSED` is a publication guard and records the pending decision; dependency licenses remain their respective owners' licenses. Choose an appropriate license with the owner before inviting reuse or distributing a release. No npm package or GitHub release is published by this project.
