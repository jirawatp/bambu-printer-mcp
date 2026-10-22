# Future hardware validation

No authenticated MCP telemetry or physical-command validation has been performed. Separate read-only identity and existing vendor-UI observations are recorded below.

The repository contains a subscribe-only X2D LAN observation path (section 0), written and tested only against in-memory fakes, and **admission-blocked**: constructing the public session is refused because the evidence ledger holds no vendor-verified label for the unresolved contract items. Admission is a code-path invariant (a pure rule with no override), not a privilege boundary: anyone who can modify the source can change it. No authorization covers settings changes, physical printing, camera access or any control.

### Evidence recorded so far (coarse, dated 2026-10-22)

| Evidence | What it is | What it is not |
| --- | --- | --- |
| Selected device identity | The selected printer was identified as X2D (model code N6) from local metadata, followed by a TLS 1.3 handshake whose chain verified against the existing vendor public CA and whose certificate matched the serial-based hostname. No MQTT packet and no credential was sent. | Not telemetry, not authentication, not proof about firmware or schema. |
| Existing Studio UI | A read-only observation on 2026-10-22 of the vendor application's existing status view, with no click or command. | It shows that Studio had status for the device, not that this MCP decoded any telemetry. No job, stage, progress, time, address, serial or ownership detail is recorded here. |
| New MCP live telemetry | Not attempted. `CONTRACT_UNVERIFIED` remains closed. | Report topic, MQTT version, subscription QoS, installed firmware, emitted schema and nozzle mapping are all unresolved; no operator observation can change that through this repository's gate. |

## 0. Prepared (blocked) operator-only passive observation procedure (X2D, read-only)

**Status: blocked. Do not attempt.** `npm run smoke:x2d-readonly` and `--enable-x2d-lan-readonly` stop with exit code 2 and the exact unresolved items before reading stdin, the environment or any file. There is no acknowledgement, environment variable or flag that bypasses this, and the gate cannot currently admit an operator observation. This document does not describe an operator-side way to open it. The text after this paragraph documents the launcher's behavior for reference only and applies solely if the gate is ever legitimately opened by a separately reviewed change backed by vendor-authored evidence.

Closing the evidence gaps is a research and review task, not an operator step. [Official research](official-research.md) records that username `bblp`, the access-code password and port 8883 are confirmed, and that the report topic, MQTT protocol version, subscription QoS, installed firmware/schema and nozzle mapping are not. A successful TLS handshake, a successful subscription or community posts are not evidence. Nozzle temperatures are not reported (`nozzlesC` is empty) until an extruder-mapping record exists.

Reference procedure (only if the gate is ever legitimately open; operator alone, never an agent or automated test; everything in memory, nothing persisted, no printer UI use, no camera, no setting change):

- Preconditions: the X2D is in the LAN mode you already use with Studio; you read its private IPv4, serial and access code yourself (do not paste them into chat, issues, shell history or this repository); `npm ci --ignore-scripts` and `npm run build` completed; the CA is operator-supplied trust, by default the public vendor certificate inside the installed Studio app (default path in `src/lan-config.ts`; override with an absolute `BAMBU_X2D_CA_FILE`). Only the supplied CA roots are trusted (default: the vendor public CA shipped with Studio); system roots are not added, chain and exact serial hostname are checked, and no TLS-relaxation option exists. The CA is not fingerprint-pinned. The CA must be a regular file: symlinks as the final component, FIFOs and devices are refused.
- Prefer stdin so secrets never reach arguments or history:

  ```sh
  read -rs LINE   # paste: {"host":"<private-ipv4>","serial":"<serial>","accessCode":"<code>"}
  printf '%s\n' "$LINE" | node dist/src/lan-smoke.js; unset LINE
  ```

  Inherited `BAMBU_X2D_HOST`, `BAMBU_X2D_SERIAL`, `BAMBU_X2D_ACCESS_CODE` and optional `BAMBU_X2D_CA_FILE` also work and are deleted from this process's environment after reading. An inherited variable is visible to the same OS user (process listings or environment files such as `/proc/<pid>/environ` on Linux) while the process runs and in whatever started it, so prefer stdin, and never put these values in an MCP host's configuration file. Any other stdin key is rejected.
- The launcher stops by itself after 60 s, 20 messages or 1 MiB, or at once (no retry) on certificate, authentication, subscription or protocol failure or Ctrl-C. It prints one sanitized JSON report: outcome, end reason, counters (including `retained-report` counts), outbound packet counts (expect `connect:1, subscribe:1, disconnect:1`, `pingreq` possibly more, `blockedOutbound:0`, never a publish count), the normalized last observation with its age and freshness at the moment of the report (`ageMsAtReport`, `freshnessAtReport`, provisional `staleAfterMsProvisional`) and the unresolved-contract list. Ages combine the wall and monotonic clocks (the larger elapsed time wins) so a clock rollback cannot make an old frame look fresh. It never prints the host, serial, code, topic or any raw payload.
- Exit codes: `0` telemetry observed, `1` failure (`end` names the stage: `tls-verify`, `authentication`, `connect-refused` (the broker refused the connection for a reason other than credentials), `subscription`, `protocol`, `timeout`, `peer-closed`, `connect`, `cancelled`), `2` closed admission or invalid input (nothing was contacted), `3` session ended with no telemetry.
- Interpret conservatively. Retained messages are ignored by design, so a broker that replays only a stored snapshot yields `no-telemetry`, not a stale-as-fresh value. `no-telemetry` with `end: limit` can mean the assumed topic or the printer's unprompted publishing produced no live `push_status` within the cap (the client deliberately never sends `pushall`); it does not prove the printer silent or the contract wrong. `tls-verify` means the certificate did not validate against the supplied CA for the exact serial: do not weaken verification. `authentication` means the code was rejected: do not retry in a loop.
- Compare observed state, progress, bed temperature and remaining time with the printer UI yourself and record only a sanitized note (template below, opaque label). Strip identifiers before any frame becomes a fixture.
- The MCP flag works the same way (environment only) and then serves `live-x2d` read-only; run it on the host, not in the network-disabled Docker container.

Success would validate only the observed model, firmware and network mode, and only the four whitelisted fields.

## 1. Establish an exact compatibility record

- Obtain explicit owner authorization for the specific device and read-only session before connecting. The owner handles device settings, risk acknowledgements and any required agreements. Do not bypass authorization or assume every firmware offers the same Developer Mode behavior.
- Record exact model/variant, installed printer firmware, relevant accessory firmware, enabled network mode, adapter revision and current official documentation reviewed. Recheck [official research](official-research.md), particularly the X2D manual's firmware scope and precedence of release notes.
- Keep device addresses, serial numbers, access codes, account tokens and camera URLs outside Git. Publish only a sanitized record with an opaque device label. Use least privilege and verified transport security; never disable certificate checks to make a connection succeed.
- Add capabilities only for the exact model/firmware/network-mode combination observed. Unknown combinations remain unsupported. Vendor documentation, mock tests and hardware observations must retain separate evidence labels.

Suggested sanitized record:

```text
Device label: test-x2d
Exact model/variant:
Printer/accessory firmware:
Network mode:
Adapter commit:
Official documents and review date:
Read-only test authorization and session date:
Observed capabilities and unsupported fields:
Test result, limitations and sanitized evidence:
```

## 2. Validate read-only X2D telemetry

- The read path in section 0 is implemented with no command publication, uploads or discovery; tests assert zero outbound PUBLISH and no reconnect. Keep confirming that startup, shutdown and errors cannot invoke a control path when it changes.
- Compare state, progress percentage, bed temperature, each nozzle temperature and time remaining against the printer UI during an owner-managed job. Record units, rounding, update frequency and uncertainty. Do not start a job for this check without separate physical-operation authorization.
- Establish the actual dual-nozzle schema: channel identifiers, main/auxiliary mapping, inactive-tool values, unavailable readings and firmware-specific encodings. Do not map an invented fixture array onto live data by assumption. H2S/H2C and other variants need their own topology records.
- Test missing fields, unknown states, malformed/out-of-range data, duplicate/out-of-order reports and firmware mismatch. Preserve unknown data as `null`; do not substitute zero or stale values as current measurements.
- Add receive timestamps and an explicit freshness threshold based on measured updates. On timeout, disconnect, authentication failure or schema change, expose stale/unavailable status and disable dependent actions. The implemented path never reconnects (a new operator run is required); any future reconnect needs bounded backoff and fresh validated data before restoring capabilities. The 60 s staleness threshold is provisional until update frequency is measured.
- Compare sanitized observed frames with adapter outputs in offline regression tests. Strip secrets and identifiers before fixtures enter Git. A read-only pass validates only the observed model, firmware and network mode. The 60 s freshness threshold is provisional, and the engine measures elapsed time as the larger of the wall-clock and monotonic deltas.

## 3. Validate camera access separately

- Obtain explicit camera permission, check field of view and agree on retention. Keep image capture/streaming disabled by default; avoid storing or transmitting views of people or private surroundings.
- Verify the model/firmware's supported authenticated camera interface, transport security and session expiry. A camera specification or open port does not establish a stable streaming API. Do not assume one camera protocol across families.
- Test denial, disconnect, stale frames and safe stop. Redact stream credentials and URLs from logs and tool responses. Do not enable a third-party relay or cloud upload as part of a local camera test.

## 4. Review controls in dry-run mode first

- Implement command preparation without sending it. Review allowlisted pause/cancel/print semantics, acknowledgements, printer/job identity, actual state transitions, expiry, replay protection and job/revision binding against exact firmware evidence.
- Require trustworthy local operator approval outside the model-controlled `confirmed` flag. Review print artifact integrity, exact printer/nozzle/plate/material compatibility and safe error handling. Never expose arbitrary commands, heating, movement, firmware changes or laser/cutting/plotting controls.
- Prove that denial, expired plans, changed jobs, stale telemetry, disconnects and retries cannot send a command. An uncertain acknowledgement must not cause an automatic repeated print/start request.
- Only after a separate code/security review and **separate future authorization** should an operator supervise physical pause/cancel tests and, later, a small approved print. Use the printer's normal local controls for intervention. Record every test outcome; do not infer broader support from one successful operation.

Repeat this sequence for each additional exact model and firmware. Updating firmware or network mode invalidates previous assumptions until regression checks establish the new compatibility record.
