# Future hardware validation

No step here has been performed. This repository currently has no hardware transport. Start with the owner's **X2D**, using a separately reviewed, authenticated **read-only** adapter. The current prototype authorization does not authorize a real printer connection, settings changes or physical printing.

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

- Implement an authenticated allowlisted read path with no command publication, uploads or automatic discovery outside the authorized scope. Confirm that startup, shutdown, reconnects and errors cannot invoke a control path.
- Compare state, progress percentage, bed temperature, each nozzle temperature and time remaining against the printer UI during an owner-managed job. Record units, rounding, update frequency and uncertainty. Do not start a job for this check without separate physical-operation authorization.
- Establish the actual dual-nozzle schema: channel identifiers, main/auxiliary mapping, inactive-tool values, unavailable readings and firmware-specific encodings. Do not map an invented fixture array onto live data by assumption. H2S/H2C and other variants need their own topology records.
- Test missing fields, unknown states, malformed/out-of-range data, duplicate/out-of-order reports and firmware mismatch. Preserve unknown data as `null`; do not substitute zero or stale values as current measurements.
- Add receive timestamps and an explicit freshness threshold based on measured updates. On timeout, disconnect, authentication failure or schema change, expose stale/unavailable status and disable dependent actions. Reconnect with bounded backoff; require fresh validated data before restoring capabilities.
- Compare sanitized observed frames with adapter outputs in offline regression tests. Strip secrets and identifiers before fixtures enter Git. A read-only pass validates only the observed model, firmware and network mode.

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
