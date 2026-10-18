# Official Bambu Lab evidence

Research date: **2026-10-18 (UTC)**. This is a compatibility research record, not a hardware certification or an official Bambu Lab API specification. No printer was accessed and no settings were changed. Only official Bambu Lab sources are used below; the manual itself is linked rather than copied into this repository.

## X2D: verified documentation, firmware caveat

The supplied [X2D 3D Printing User Manual](https://csm.bblcdn.com/hub/7c58718aaa2e40edab56efb87419a96a.pdf) is hosted on Bambu's document CDN. Its title page identifies version **1.0, 2026.05**. Page 1 says it applies to firmware **01.01.00.00**, displays/features can vary with firmware, and release notes take precedence.

Pages 100–101 document LAN-only operation and Developer Mode. LAN-only removes internet access/cloud features such as Bambu Handy and print history. Developer Mode permits third-party management of print tasks and process data after LAN-only is enabled; the manual limits it to **3D printing**. This establishes documented X2D integration intent, not a tested wire protocol. The manual contains no MQTT message schema.

The [X2D firmware history](https://wiki.bambulab.com/en/x2d/manual/X2D-firmware-release-history) lists **01.02.00.00 (2026-07-30)**, newer than the manual's declared firmware. The owner's installed version remains unknown. The [official X2D product page](https://bambulab.com/en/x2d) independently confirms the model and dual-nozzle design. Neither source certifies this prototype.

## Model and firmware evidence matrix

“Documented” below describes vendor documentation. Every adapter in this repository remains hardware-untested, including X2D. A family name alone must never enable a command or camera connection.

| Prototype family | Official evidence | Consequence for capability discovery |
| --- | --- | --- |
| A1 (A1 / A1 mini candidates) | The [Developer Mode guide](https://wiki.bambulab.com/zh/knowledge-sharing/enable-developer-mode) has an A-series section. The [A1 firmware history](https://wiki.bambulab.com/en/a1/manual/a1-firmware-release-history) describes Authorization Control and Developer Mode. [A1 specs](https://bambulab.com/en/a1/tech-specs) describe a low-rate monitoring camera up to 1080p. | Verify exact model and installed firmware; do not infer A1 mini firmware behavior from A1 release notes. Camera hardware does not establish a common streaming API. |
| P1 (P1P / P1S candidates) | The same guide has a P1 section; [LAN guidance](https://wiki.bambulab.com/en/knowledge-sharing/enable-lan-mode) names P1P/P1S. The [P1 introduction](https://wiki.bambulab.com/en/p1/manual/intro-p1p) describes a low-rate 1280×720 camera at 0.5 fps. [P1 firmware history](https://wiki.bambulab.com/en/p1/manual/p1p-firmware-release-history) is separate from X1/A1. | No universal Developer Mode minimum version was established here. Validate P1 firmware and hardware configuration independently. |
| X1 (X1 / X1C candidates) | The guide has an X-series section. [X1/X1C firmware history](https://wiki.bambulab.com/en/x1/manual/X1-X1C-firmware-release-history) documents authorization changes and LAN Developer Mode. [X1 introduction](https://wiki.bambulab.com/en/x1/manual/intro-x1) documents camera monitoring via Studio/Handy. | Treat X1E as a separate future variant; this evidence does not establish matching X1E behavior. |
| H2 (H2D / H2S / H2C candidates) | The guide has an H2-series section. [H2D firmware history](https://wiki.bambulab.com/en/h2d/manual/h2d-firmware-release-history) documents Developer Mode for 3D printing. The [H2C buying guide](https://bambulab.com/en/support/buying-guide?id=906598830092476416&page=4) explicitly describes Developer Mode integration via MQTT ports. [H2D specs](https://bambulab.com/en/h2d/tech-specs) list multiple cameras. | Do not collapse H2 variants or 3D-printing/laser/cutting modes into one permission. Laser, cutting and plotting are outside this prototype. |
| X2D | Manual and firmware history above explicitly cover X2D. | Keep a distinct adapter and dual-nozzle representation. Actual telemetry keys, command acknowledgements and camera transport remain unverified. |

The current [official comparison](https://bambulab.com/en/compare) lists A1, A1 mini, P1S, X1C, H2D, H2S, H2C and X2D among a wider lineup. This verifies product names, not MCP compatibility.

## Third-party control and camera boundaries

The [official January 2025 integration update](https://blog.bambulab.com/updates-and-third-party-integration-with-bambu-connect/) distinguishes standard authorization from optional, manually enabled LAN Developer Mode. It names X1/P1/A1/A1 mini and says MQTT, livestream and FTP access can be opened, while the communication protocols are not officially supported. This historical announcement is context; use current model release notes and explicit discovery rather than assuming its promise applies uniformly forever.

The current [Developer Mode guide, Chinese original](https://wiki.bambulab.com/zh/knowledge-sharing/enable-developer-mode) documents LAN-only as a prerequisite and includes H2/P2S, X, P1 and A sections. It requires an on-device risk acknowledgement. This project does not enable that setting or accept that acknowledgement for the owner.

The [third-party integration wiki, official Spanish version](https://wiki.bambulab.com/es/software/third-party-integration) says authorization applies to selected commands in cloud and normal LAN modes, including remote camera access through the network plugin and starting print jobs. The [Bambu Connect guide](https://wiki.bambulab.com/en/software/bambu-connect) describes importing sliced files into Bambu Connect and currently says Liveview is not supported there. That is a distinct integration path, not a general MQTT/camera SDK. No Connect integration or SDK enrollment is performed here.

The [official network-port reference](https://wiki.bambulab.com/en/general/printer-network-ports) lists LAN MQTT TCP 8883, FTP TCP 990 and LAN-video TCP 322/6000. A port table is not a published message schema, endpoint contract, authentication specification or per-model compatibility guarantee. The prototype must not fabricate MQTT payloads, assume one camera protocol, disable certificate verification, or treat a reported open port as authorization to control a printer.

## Evidence limitations and validation next steps

The X2D PDF was opened and its text verified directly. Some wiki direct fetches returned errors; those claims were checked against search-indexed content from the linked official pages. Translated official wiki pages can lag or contain translation errors. No API SDK, device credential, developer agreement or network plugin was obtained.

Before a real adapter is enabled, record exact model, firmware and network mode; review current model release notes; have the owner handle any settings/terms; validate a minimal authenticated read-only transport; compare sanitized status, progress, temperatures and remaining-time values against the printer UI; test missing/partial/stale data and disconnects. Keep unsupported data null/unknown. Validate camera privacy/authentication separately. Pause/cancel and especially print execution require separate explicit hardware-test authorization, supported commands, state checks and local operator supervision. Never use a mock fixture as proof of printer support.
