# Generator Safety

Pinout Generate produces **candidate** modules from documentation. Those candidates are **untrusted** until a human verifies them against real hardware.

## Core principles

1. **Generated code is untrusted.** Treat every generated backend, policy, and simulator as provisional source material — not production firmware drivers.
2. **Generated constraints may be incomplete.** Missing documentation yields `NO SAFE RANGE FOUND` and explicit uncertainties — not invented limits.
3. **Conformance ≠ physical certification.** `pinout module test` checks manifest structure, schemas, policy references, and simulator lifecycle. It does **not** prove safe behavior on a machine.
4. **Human review is required.** Every generated module includes `GENERATION_REPORT.md` with review checklists and `PINOUT_REVIEW_REQUIRED` markers in code where behavior is uncertain.
5. **Hardware testing is separate.** Connecting to physical devices requires explicit `pinout module install`, device registration, and operator configuration. Generation never auto-connects.

## Safety generation rules

| Source material | Generator behavior |
| --- | --- |
| Explicit documented range (e.g. "10°C to 80°C") | Hard policy with high confidence |
| Inferred limit (e.g. "max 80°C" without full range) | `candidate` constraint with `requiresHumanReview: true` — **not** promoted to hard policy |
| Missing limit | Uncertainty recorded; **no invented bound** |
| Conflicting documentation | Critical uncertainty; no silent merge |

Low-confidence capabilities (< 0.70) are flagged in plans and reports.

## Candidate lifecycle

Local metadata tracks progression:

```text
GENERATED → CONFORMANCE_PASSED → SIMULATION_TESTED → HUMAN_REVIEWED → HARDWARE_TESTED
```

Sprint 4 modules start at `GENERATED` only. No centralized certification infrastructure exists yet.

## What generation does not do

- Auto-install modules
- Auto-register devices
- Open serial/TCP/BLE/MQTT connections to hardware
- Flash firmware
- Execute generated wire-protocol code against real machines
- Reverse-engineer arbitrary binaries
- Claim "verified" or "certified" status
- Claim evidence higher than `COMPILE_TESTED` (connectors use core `SupportLevel` / `mapFromGeneratorLifecycle` with `generated: true`; typically `SIMULATED`)

## Connector default-deny

For `physicalOutput` capabilities inferred from GATT writes, MQTT publishes, or bridge actuation lists, the generator emits **strict** JSON Schemas (`additionalProperties: false`) and **policy stubs** marked `requiresApproval` until a human supplies documented numeric ranges. Observed sample min/max values are recorded as uncertainties (data), never promoted to hard limits. See [generator-connectors.md](generator-connectors.md).

## Sanctioned install path (connectors)

Generation itself still never installs. The **only** supported path from a
generated candidate into `~/.pinout/modules` is the human-gated connector
pipeline (daemon + CLI):

1. `pinout connector generate --awareness <id>` — conformance gate; quarantine on pass (`CANDIDATE` on fail).
2. `pinout connector approve <id> --capabilities … --ranges …` — human step; policy ranges + journal who/when.
3. `pinout connector install <id>` — integrity-checked persist + hot-register.

See [connectors.md](connectors.md). Reject with `pinout connector reject <id>`.
Never skip approval. Evidence stays capped at `COMPILE_TESTED` without a dated
`hardware/records/` entry.

## Operator checklist

Before running generated code against hardware:

- [ ] Verify transport (serial/TCP/SDK) against vendor documentation
- [ ] Verify capability semantics and units
- [ ] Verify safety constraints with primary sources
- [ ] Verify simulator behavior matches expected state model
- [ ] Run targeted hardware tests in a controlled environment
- [ ] Prefer the connector pipeline (`pinout connector approve` → `install`) or, for hand-authored modules, `pinout module install <path>` after review

## Reporting issues

If the generator produces a confident safety constraint without evidence, treat it as a bug. False confident claims around physical limits are more dangerous than missed capabilities.
