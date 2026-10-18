# Security model

This prototype is local, **mock-only**, and hardware-untested. Report software issues through this repository without attaching credentials, device serials, access codes, network addresses or camera images. No private vulnerability-reporting service is assumed to be configured.

## Enforced boundaries

- Only stdio is served. There is no HTTP listener, remote endpoint, network discovery, MQTT/FTP/video client or cloud account integration.
- No tool accepts an address, device credential, file path, URL, G-code, shell command or raw printer command. Strict input schemas reject extra fields.
- Controls and camera are disabled by default. Startup flags enable simulations only; no flag enables a real transport.
- A finite action enum and fixed synthetic artifact allowlist constrain control requests. Prepared actions bind printer, job, action and state revision; expiration, replay and state checks apply again at execution.
- Unknown firmware and invalid/missing state fail closed for actions. Missing data is never replaced by an invented safe temperature or progress reading.
- Camera output is a synthetic placeholder and separately gated. No camera URL or credentials are returned.
- MCP errors use bounded application messages; no raw transport exception is sent to the client. Server diagnostics use stderr.
- Dependencies are locked. Installs disable lifecycle scripts. CI has read-only repository permissions and does not persist checkout credentials. No printer or cloud secrets are used by tests.
- The Docker runtime uses the unprivileged `node` user with root-owned application files and production dependencies. The documented run command disables networking, writes, Linux capabilities and privilege escalation, mounts no host data/devices/socket, and limits CPU, RAM and processes. These runtime flags are operator configuration; the image alone cannot enforce them.

## Trust limits

The local user and MCP host can launch and invoke this process. Stdio relies on operating-system process isolation; this server does not authenticate an identity. Any client allowed to use an opted-in simulator can submit `confirmed: true`. Plan identifiers are workflow references, not credentials or human-consent tokens. A malicious host can modify its local source or call tools repeatedly. Tool annotations are hints and are not authorization controls.

Simulated state checks are not a physical safety system. No emergency stop, thermal protection, collision detection, material compatibility or machine interlock is implemented. Never attach a real transport to these tools merely because a test passes.

## Before any hardware adapter

Require separate owner authorization and exact model/firmware/network-mode evidence. Start with read-only telemetry. Keep device secrets in an OS secret store or untracked local configuration and redact them from prompts, logs, exports and tests. Use verified encrypted/authenticated transport; do not disable certificate validation. Restrict destinations and payloads to a reviewed device allowlist. Keep authorization, privacy permissions, command acknowledgement, timeout/uncertain outcome handling and freshness separate from telemetry parsing.

A future physical command needs an independently trusted approval path bound to the exact target, job/artifact, action and expiry. An LLM's own confirmation is insufficient. Recheck state immediately before dispatch, deduplicate requests, never retry an uncertain physical action automatically, and retain safe local operator control. Do not enable Developer Mode or accept vendor acknowledgements automatically. Laser, cutting, plotting, settings, heating, motion and firmware operations remain outside scope.
