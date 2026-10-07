# Crash-Window B HIL Procedure (physical lamp)

Window B = dispatched, ACK not recorded. Must stay visible as uncertain on a real lamp: do not auto-replay `lamp.on`.

> Parent: #13. Software analog: `packages/core/tests/recoveryCrashWindows.test.ts`. Model: `docs/recovery-model.md`.

## Procedure

1. Arm lamp, start `lamp.on` with an idempotency key. Kill the daemon with SIGKILL after `lamp.on` is on the wire but before the client sees completion (best effort timing).
2. Restart daemon. Confirm operation shows `requires_reconciliation`, not `completed` or `aborted`.
3. Look at the LED. Reconcile with `observedComplete` if lit, `observedNotDone` if dark. Record both in separate columns.
4. Confirm the same idempotency key cannot silently actuate again (re-invoke blocked).
5. Optional: competing lease still cannot actuate during uncertainty.

## Evidence matrix (copy into record)

| Step | LED state (look) | Operation status | Reconcile payload | Replay blocked? |
| :--- | :--- | :--- | :--- | :--- |
| B.1 kill during `lamp.on` | on/off/dark? + timestamp | `requires_reconciliation` | n/a yet | n/a |
| B.2 reconcile | same LED state | `reconciled` + outcome | `observedComplete` or `observedNotDone` | — |
| B.3 same-key retry | LED unchanged | rejected, no actuation | n/a | yes/no + error code |
| B.4 competing lease (opt) | LED unchanged | rejected | n/a | yes/no + error code |

Do not treat journal replay as physical proof. ACK column and LED column must differ in source.
