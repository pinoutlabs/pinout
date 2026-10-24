# `@pinout/awareness`

Persistent device observation for Pinout. Tracks every device ever seen,
exposes a typed HTTP/SSE client, and never actuates hardware.

See [docs/awareness.md](../../docs/awareness.md).

**Honesty:** records default to `evidenceLevel: 'SIMULATED'`. Enrollment is
operator-approved only (`PENDING_ENROLL` → `ONLINE` via `POST /v1/awareness/:id/enroll`).
Never auto-flash. Never auto-enroll.
