# OAHL vs Pinout: factual comparison

Prepared 2026-10-26 (UTC). Every claim cites a source at the end. OAHL repo facts were read at commit `44398733` of [github.com/fredabila/oahl](https://github.com/fredabila/oahl). Pinout facts are from this repository at commit `70715252`.

**Evidence honesty.** All Pinout hardware evidence in this repo is `SIMULATED` or `COMPILE_TESTED`. Nothing is `HARDWARE_VERIFIED` ([docs/evidence-levels.md](evidence-levels.md), [hardware/records/README.md](../hardware/records/README.md)). OAHL's own hardware results are self-reported.

## 1. Was OAHL found?

Yes. One project uses the exact name "Open Agent Hardware Layer":

- Site: https://oahl.org/ (redirects to https://www.oahl.org/) [S1]
- Repo: https://github.com/fredabila/oahl, MIT licensed, 10 stars, created 2026-03-13T13:04:38Z, last push 2026-03-31T12:08:57Z [S2]
- Paper: DataCite DOI [10.13140/rg.2.2.16835.57128](https://doi.org/10.13140/rg.2.2.16835.57128), title *OAHL -Open Agent Hardware Layer…*, creator Frederick Abila, year 2026, registered as unpublished / ResearchGate deposit. Not on arXiv (query returned no matching paper) [S4][S6]
- npm: `@fredabila/oahl` 1.0.0 [S5]

Other GitHub repos named "oahl" exist and are unrelated (for example AlexisHL1708/OAHL holds class exercises) [S3].

Terminology: OAHL does not use the term "safety engine". Its component is called `PolicyEngine` [S7][S8].

## 2. What OAHL defines (repo-verified)

| Area | What OAHL specifies | Source |
|---|---|---|
| Maintainer | Git author Frederick / Fredrick Abila (`fredabila`); 82 commits on the pinned tip, sole GitHub commit author login. | [S2] |
| Lifecycle | Discover, reserve, execute (single or batch), release: `GET /v1/capabilities`, `POST /v1/requests`, `POST /v1/sessions/{id}/execute`, `/execute-batch`, `/stop`. | [S7][S9] |
| Capability semantics | Each capability MUST carry a JSON Schema. Names SHOULD use `<domain>.<action>` with a fixed domain vocabulary (camera, radio, sensor, phone, robot, lab, ui, file, system, app, input, screen). Optional `instructions` and `semantic_type` (W3C WoT ActionAffordance). | [S7][S10] |
| Device descriptor | `Device {id, type, name, isPublic, manufacturer, model, serial_number, semantic_context, metadata, pricing}`. | [S8][S10] |
| Result envelope | `schema_version`, `operation_id`, `status` (`accepted`, `in_progress`, `success`, `error`), `completion`, and an error object with `retryable` and `agent_recovery_hints`. Catalog of 12 standard error codes, including `POLICY_DENIED`. | [S7] |
| Constraint model | Cloud `access_policy` (visibility + agent/org allow/deny lists). Node `PolicyEngine`: `{deviceId, maxDurationMs, allowedCapabilities, disabledCapabilities}`; if a device has no policy, every capability is allowed. Exclusive sessions; cloud inactivity expiry 3600 s. Cloud Ajv param validation and execute rate limit (default 120/min per `x-agent-id`). | [S7][S8][S11][S12] |
| Identity | Bearer tokens; agent keys separate from provider keys. Identity headers are self-asserted in v1. Signed JWT / mTLS, replay protection, and node attestation are RFCs marked "Accepted (Pending Implementation)". | [S7][S11][S13] |
| Transport | Agent↔cloud REST (OpenAPI 3.0). Cloud↔node WebSocket with HTTP long-poll fallback (AsyncAPI). Attachment profiles list usb, serial, gpio, i2c, spi, ble, tcp, mqtt, coap, webrtc, and others. | [S7][S9][S14] |
| MCP | CLI includes an MCP server that maps device capabilities to tools. | [S15] |
| Conformance | Spec lists 7 conformance targets and states the suite is "under development". Repo has an adapter conformance CLI with 4 numbered targets and `packages/core/test/conformance.test.js` with 15 `test()` cases. | [S7][S16] |
| Maturity | Protocol: "Status: Stable (v1.0)". Roadmap: "Foundation complete, ecosystem incomplete". Root `package.json` version `0.1.1`. | [S7][S17][S2] |
| License | MIT in `LICENSE`. | [S2] |

### Conflicts and gaps inside OAHL sources

1. **Node policy enforcement.** The security guide says the node `PolicyEngine` runs before adapter execution. In `packages/server/src/index.ts`, `PolicyEngine` is imported, but there is no call to `isCapabilityAllowed` [S11][S18]. Runtime node enforcement is therefore unverified from that file.
2. **Security guide vs cloud code.** The security guide lists rate limiting and cloud schema validation as not implemented. `packages/cloud/src/index.ts` contains `express-rate-limit`, Ajv, and bcrypt [S11][S12]. The guide appears out of date relative to the cloud package.
3. **Transports in-repo.** `packages/core/src/transports/` contains `ble-stub.ts`, which states it does NOT perform real BLE operations. No `serialport` or MQTT dependency appears in the root package graph at the pinned commit [S19].
4. **Hardware claims.** The README describes a TECNO phone / ADB demo. Those hardware outcomes are self-reported; this page does not independently reproduce them [S2].

## 3. Five key differences

1. **Scope and topology.** OAHL is a multi-tenant cloud-relay architecture: nodes connect outbound to a cloud registry; remote agents reserve devices through it. Pricing descriptors and marketplace docs exist [S7][S8][S20]. Pinout is a local runtime: `pinoutd` is intended for loopback use, and the module registry is offline-first with no live registry service ([docs/security-model.md](security-model.md), [docs/registry.md](registry.md), [docs/production-architecture.md](production-architecture.md)).
2. **Safety model depth.** OAHL's implemented constraint model is capability allow/deny lists, visibility ACLs, session exclusivity, and schema validation; devices without a policy default to allow [S8][S7]. Pinout's safety engine evaluates argument-level rules including `numericRange`, `lease`, and `deadman` ([docs/spec/safety.md](spec/safety.md), `packages/core/src/policy/safety.ts`). It requires explicit arm / lease / deadman gating for actuation ([docs/safety-model.md](safety-model.md), [docs/spec/leases.md](spec/leases.md), [docs/daemon.md](daemon.md)), declares `safeState` behavior, and keeps generated connectors `QUARANTINED` (read-only; physical output blocked until human approve + ranges) ([docs/connectors.md](connectors.md), [docs/generator-safety.md](generator-safety.md)).
3. **Evidence honesty model.** OAHL has no evidence-level taxonomy and labels the protocol "Stable v1.0" while the conformance suite is "under development" [S7]. Pinout uses `UNKNOWN` → `SIMULATED` → `COMPILE_TESTED` → `HARDWARE_VERIFIED`. Hardware records show `SIMULATED`, `COMPILE_TESTED`, or `NOT RUN` only; no `HARDWARE_VERIFIED` entry ([docs/evidence-levels.md](evidence-levels.md), [hardware/records/README.md](../hardware/records/README.md)).
4. **Device class focus.** OAHL reference adapters in-repo are mock, USB camera, and RTL-SDR; the README demo target is an Android phone over ADB [S2]. Pinout targets microcontroller and industrial actuation paths: ESP32 firmware, MicroPython bridge, Modbus and SCPI protocol packages, and a ROS 2 sidecar ([README](../README.md), [docs/ros2-sidecar.md](ros2-sidecar.md), `packages/protocols-modbus`, `packages/protocols-scpi`).
5. **Wire contracts and agent surfaces.** OAHL publishes OpenAPI 3.0, AsyncAPI, and JSON Schemas for envelopes and attachment profiles, plus a WoT alignment doc [S9][S14][S10]. Pinout's contracts are prose under `docs/spec/` (including structured errors with `retryable` in [docs/spec/errors.md](spec/errors.md); no `agent_recovery_hints` field). This repo has no OpenAPI or AsyncAPI protocol artifact and no WoT alignment document. Pinout does ship an MCP adapter (`packages/mcp`, [docs/mcp.md](mcp.md)) and RAP / Infinity adapters ([docs/rap.md](rap.md), [docs/infinity.md](infinity.md)).

## 4. Different layers, and Pinout's `protocols-oahl` bridge

OAHL (fredabila/oahl) is a **cloud-mediated agent↔hardware protocol and relay**. Pinout is a **local governed runtime** (leases, safety engine, arm/deadman, journal, evidence levels). They are different layers: speaking a similar lifecycle vocabulary does not make them the same product.

Pinout includes `packages/protocols-oahl` (`@pinout/protocols-oahl`). Reading the code: `OahlBridge` wraps a local `PinoutRuntime` and `LeaseManager` and exposes an OAHL-shaped lifecycle (`discover`, `reserve`, `renew`, `execute`, `release`). `OahlHttpServer` serves that over loopback HTTP at `/oahl/v1/*`. It maps Pinout devices, capability schemas, and safety flags into the bridge's device catalog, and maps reservations onto Pinout leases. It does **not** implement OAHL's cloud registry, marketplace, WebSocket node relay, or `access_policy` multi-tenant ACLs.

## 5. Where OAHL is better (sourced)

- **Remote, multi-tenant access.** Working cloud relay docs and code: node registration, WebSocket path with polling fallback, owner/org/agent visibility ACLs. Remote agents can use hardware on other machines. Pinout has no hosted service and targets loopback [S7][S12][S20]; [docs/security-model.md](security-model.md), [docs/production-architecture.md](production-architecture.md).
- **Machine-readable protocol contracts.** OpenAPI 3.0, AsyncAPI, and JSON Schemas for execution results and attachment profiles. Third parties can generate clients. Pinout has no equivalent repo artifact [S9][S14][S2].
- **Standards alignment.** Documented mapping to W3C WoT ActionAffordance and deliberate divergences. Pinout has no WoT alignment doc [S7][S10].
- **Reported runs on real hardware.** OAHL's README describes end-to-end use with a physical Android phone over ADB. Those results are self-reported. All Pinout evidence remains `SIMULATED` or `COMPILE_TESTED` [S2]; [hardware/records/README.md](../hardware/records/README.md).
- **Typed LLM recovery hints in errors.** OAHL's error object includes `retryable` and `agent_recovery_hints` [S7]. Pinout's [docs/spec/errors.md](spec/errors.md) defines `retryable` and stable codes, but has no `agent_recovery_hints` (or equivalent) field.

Left out of the list above on purpose: argument-level physical safety, default-deny / quarantined physical outputs, `safeState`, deadman and arm gating, and evidence labeling. OAHL's sources do not show implemented equivalents to those Pinout mechanisms [S8][S18].

## Sources

- [S1] https://oahl.org/ (→ https://www.oahl.org/)
- [S2] https://github.com/fredabila/oahl (README, LICENSE, package.json, git history at commit `44398733986866494c72cb63bb63a1a8a5904615`)
- [S3] GitHub repository search: https://api.github.com/search/repositories?q=OAHL
- [S4] DataCite / DOI https://doi.org/10.13140/rg.2.2.16835.57128 (ResearchGate deposit metadata)
- [S5] https://registry.npmjs.org/@fredabila/oahl
- [S6] arXiv API: `all:"Open Agent Hardware Layer"` (no results)
- [S7] https://github.com/fredabila/oahl/blob/44398733986866494c72cb63bb63a1a8a5904615/docs/oahl-protocol-v1.md
- [S8] https://github.com/fredabila/oahl/blob/44398733986866494c72cb63bb63a1a8a5904615/packages/core/src/types.ts and `…/PolicyEngine.ts`
- [S9] https://github.com/fredabila/oahl/blob/44398733986866494c72cb63bb63a1a8a5904615/openapi.yaml
- [S10] https://github.com/fredabila/oahl/blob/44398733986866494c72cb63bb63a1a8a5904615/docs/semantic-metadata-guide.md and `…/docs/wot-alignment.md`
- [S11] https://github.com/fredabila/oahl/blob/44398733986866494c72cb63bb63a1a8a5904615/docs/security-guide.md
- [S12] https://github.com/fredabila/oahl/blob/44398733986866494c72cb63bb63a1a8a5904615/packages/cloud/src/index.ts
- [S13] https://github.com/fredabila/oahl/blob/44398733986866494c72cb63bb63a1a8a5904615/docs/rfcs/001-signed-agent-identity.md and `…/002-node-attestation.md`
- [S14] https://github.com/fredabila/oahl/blob/44398733986866494c72cb63bb63a1a8a5904615/docs/transport-attachment-profiles.md and `…/docs/asyncapi.yaml`; also `oahl-execution-result.schema.json`, `oahl-attachment-profile.schema.json`
- [S15] https://github.com/fredabila/oahl/blob/44398733986866494c72cb63bb63a1a8a5904615/packages/cli/src/mcp.ts
- [S16] https://github.com/fredabila/oahl/blob/44398733986866494c72cb63bb63a1a8a5904615/packages/cli/src/conformance.ts and `…/packages/core/test/conformance.test.js`
- [S17] https://github.com/fredabila/oahl/blob/44398733986866494c72cb63bb63a1a8a5904615/docs/oahl-standardization-roadmap.md
- [S18] https://github.com/fredabila/oahl/blob/44398733986866494c72cb63bb63a1a8a5904615/packages/server/src/index.ts
- [S19] https://github.com/fredabila/oahl/blob/44398733986866494c72cb63bb63a1a8a5904615/packages/core/src/transports/ble-stub.ts
- [S20] https://github.com/fredabila/oahl/blob/44398733986866494c72cb63bb63a1a8a5904615/docs/overview.md and `…/docs/marketplace-billing-guide.md`
