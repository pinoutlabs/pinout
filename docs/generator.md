# Pinout Generate — Hardware Module Compiler

Sprint 4 introduces `@pinout/generator`, a compilation pipeline that turns hardware documentation and SDK source into **candidate** external Pinout modules.

```text
Hardware docs / SDK
        │
        ▼
  Source ingestion
        │
        ▼
  Hardware Interface IR
        │
        ▼
  Module plan → code generation
        │
        ▼
  Candidate module (UNVERIFIED)
        │
        ▼
  pinout module test → human review → install
```

Generated modules are **never** auto-installed or connected to physical hardware.

## Quick start

From the Pinout repository:

```bash
# Inspect a generation plan (no files written)
npm run pinout -- generate ./fixtures/generator/heatbox-sdk --plan

# Generate a candidate module
npm run pinout -- generate ./fixtures/generator/heatbox-sdk --output /tmp/heatbox-module

# Run conformance (structure/API — not physical certification)
npm run pinout -- module test /tmp/heatbox-module
```

Review `GENERATION_REPORT.md` inside the output directory before trusting any capability or safety constraint.

## CLI

```bash
pinout generate <source> [options]
```

| Option | Description |
| --- | --- |
| `--plan` | Print device plan only; do not write files |
| `--output <path>` | Output directory for candidate module |
| `--provider <name>` | Generator provider (`mock`, `http`) |
| `--model <id>` | Model id for the provider |
| `--device-class <class>` | Hint for device class inference |
| `--test` | Run module conformance after generation |
| `--json` | Machine-readable output (via global `--json` flag) |

## Supported sources

| Type | Extensions |
| --- | --- |
| Plain text / Markdown | `.txt`, `.md` |
| Source code | `.ts`, `.js`, `.py`, `.c`, `.cpp`, `.h`, `.hpp` |
| Structured data | `.json`, `.yaml`, `.yml` |
| Directories | Recursively ingests supported files |

Directory ingestion skips `.git`, `node_modules`, build artifacts, binaries, and oversize files.

PDF input is architected for future plug-in; initially use extracted text or Markdown.

## Pipeline stages

Each stage produces inspectable artifacts:

1. **Source ingestion** — normalizes inputs to `SourceDocument` with paths and line references.
2. **Interface extraction** — finds vendor methods, commands, and symbols.
3. **Semantic capability mapping** — maps vendor primitives to Pinout families (`temperature.set`, `motion.move_to`, …).
4. **Safety extraction** — documented limits vs inferred candidates vs unknowns.
5. **Module plan** — human-readable summary with confidence bands.
6. **Code generation** — manifest, backend, simulator skeleton, tests, evidence report.
7. **Build + conformance** — compiles TypeScript and runs `pinout module test` when `--test` is set.

## Hardware Interface IR

The IR is the central artifact. Every inferred fact carries **evidence**, **confidence**, and optional **source location**.

Key fields:

- `device` — vendor, model, device class
- `interfaces` — `tcp` · `serial` · `http` · `sdk` · `unknown` · `ble-gatt` · `mqtt` · `mdns` · `serial-bridge`
- `capabilities` — semantic capability ids with arguments, optional `safetyClass` / `requiresApproval`
- `safety` — range, precondition, candidate constraints (default-deny stubs when ranges missing)
- `uncertainties` — explicit unknowns (preferred over hallucination)
- `evidence` — source references

Connector building for awareness / GATT / MQTT / mDNS uses `generateConnector` — see [generator-connectors.md](generator-connectors.md).

Confidence bands:

| Score | Band |
| --- | --- |
| ≥ 0.90 | HIGH |
| 0.70–0.89 | MEDIUM |
| < 0.70 | LOW |

## Provider abstraction

Generation logic does not depend on a single AI vendor:

```ts
interface GeneratorModel {
  generateStructured<T>(request: GenerationRequest<T>): Promise<T>;
}
```

Built-in providers:

| Provider | Use |
| --- | --- |
| `mock` | Deterministic heuristic extraction — **default for CI** |
| `http` | OpenAI-compatible structured output API |

Configure via environment:

```bash
export PINOUT_GENERATOR_PROVIDER=mock   # default
export PINOUT_GENERATOR_MODEL=mock-v1
export PINOUT_GENERATOR_API_URL=...     # http provider
export PINOUT_GENERATOR_API_KEY=...     # never logged or written to reports
```

Optional live evaluation:

```bash
npm run eval:generator:live
```

Normal CI uses `npm run eval:generator` (mock only, no network).

## Generated module layout

```
acme-heatbox/
├── pinout.module.json
├── package.json
├── src/
│   ├── index.ts
│   ├── backend.ts
│   └── generated.ts
├── test/
│   ├── module.test.ts
│   └── generated.test.ts
├── evidence/
│   └── report.json
├── GENERATION_REPORT.md
└── README.md
```

Generated code imports **only** public `@pinout/core` SDK exports (`defineModule`, `action`, policies, etc.).

Status begins at `GENERATED` — not `VERIFIED`.

## Fixtures and evaluation

Fixture vendor SDKs live under `fixtures/generator/`:

| Fixture | Purpose |
| --- | --- |
| `heatbox-sdk` | Clear chamber docs — temperature, door, experiment |
| `actuator-sdk` | Robotic arm — motion, gripper, status |
| `ambiguous-sdk` | Conflicting docs — must surface uncertainties |

Run evaluation:

```bash
npm run eval:generator
```

Metrics include capability precision/recall, constraint accuracy, false safety constraints, and uncertainty detection. **False confident safety claims** are treated as the most severe failure mode.

## Regeneration

If `--output` already contains files, generation refuses to overwrite unless an explicit overwrite strategy is added in a future sprint. Manual edits in generated modules are preserved by conservative refusal.

## Package

`@pinout/generator` lives in `packages/generator/`. `@pinout/core` has no AI dependencies.

See also [generator-safety.md](generator-safety.md).
