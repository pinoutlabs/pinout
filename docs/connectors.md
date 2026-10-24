# Connector pipeline

Generated device connectors move through a **human-gated** pipeline before they
can actuate hardware. Generation alone never installs, flashes, or drives
outputs.

```text
awareness record
      │
      ▼
 POST /v1/connectors/generate
      │
      ├─ conformance FAIL ──► status CANDIDATE (report only)
      │
      └─ conformance PASS ──► status QUARANTINED
                                │  read-only capabilities only
                                ▼
                       POST …/approve   (human + policy ranges)
                                │
                                ▼
                       POST …/install   → ~/.pinout/modules + runtimeModules
```

Status values: `CANDIDATE` | `QUARANTINED` | `APPROVED` | `INSTALLED` | `REJECTED`.

## Safety rules

1. **No auto-install.** Generation writes under `~/.pinout/connectors/<id>/` only.
2. **Conformance gate before quarantine.** Typecheck/load + module conformance run in an out-of-process worker (`packages/daemon/workers/conformanceWorker.mjs`) with cwd restricted to the module directory. Failure stays `CANDIDATE`.
3. **Quarantine is read-only.** `physicalOutput` capabilities stay disabled until `/approve` names them and supplies numeric `ranges` enforced by the policy engine (`numericRange`) plus `safeState` on close.
4. **Evidence capped.** Generated connectors use `SupportLevel` and never exceed `COMPILE_TESTED` without a dated `hardware/records/` entry. Never auto-flash, auto-approve, or auto-actuate.
5. **Integrity on install.** Install re-checks the content hash; tampering fails closed. Hot-register into `runtimeModules` without restart; emit `connector.installed` for MCP tool-cache invalidation.
6. **Journaled.** Every transition appends to `~/.pinout/journal/pinoutd.jsonl` (`connector.generated` / `quarantined` / `approved` / `installed` / `rejected`).

## Daemon API

All mutating routes require the daemon bearer token when configured.

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| `POST` | `/v1/connectors/generate` | `{ awarenessId }` | Builds IR from the awareness record, calls `generateConnector`, stores result |
| `GET` | `/v1/connectors` | — | List summaries |
| `GET` | `/v1/connectors/:id` | — | Capabilities, safety flags, report, status, evidenceLevel |
| `POST` | `/v1/connectors/:id/approve` | `{ capabilities, ranges, approvedBy? }` | Human step; journals who/when |
| `POST` | `/v1/connectors/:id/install` | `{}` | Persist + hot-register |
| `POST` | `/v1/connectors/:id/reject` | `{ reason?, rejectedBy? }` | Uninstalls if needed |

`ranges` shape: `{ "cap.name": { "param": { "min": 0, "max": 1 } } }`.

## CLI

```bash
pinout connector list
pinout connector show <id>
pinout connector generate --awareness <id>
pinout connector approve <id> --capabilities heater.set,sensor.read \
  --ranges '{"heater.set":{"duty":{"min":0,"max":0.4}}}' --by operator
pinout connector install <id>
pinout connector reject <id> --reason unsafe
```

Commands talk to `pinoutd` (`PINOUT_DAEMON_URL` / `PINOUT_TOKEN`).

## Integration with awareness + generator

- **Awareness (PR1):** `POST /v1/connectors/generate` loads the record via the daemon
  `AwarenessService` / `AwarenessRegistry` (`GET /v1/awareness/:id`). IR is derived
  from identity + advertised capabilities (never invents physical limits).
- **Generator (PR3):** the daemon calls `@pinout/generator` `generateConnector({ source: 'ir', ir, outDir })`.
  Evidence uses core `SupportLevel` / `mapFromGeneratorLifecycle` and stays capped at
  `COMPILE_TESTED` without a dated `hardware/records/` entry.
- See [awareness.md](awareness.md), [generator-connectors.md](generator-connectors.md),
  [generator-safety.md](generator-safety.md), [modules.md](modules.md), [daemon.md](daemon.md).
