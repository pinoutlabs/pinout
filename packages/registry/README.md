# @pinout/registry

Offline-first Pinout module registry (v0). A registry is a directory with a
`registry.json` index plus module payloads; packs, verification, and
installation are plain filesystem operations. Nothing here calls a hosted
service: `https://` index URLs are supported through an injectable fetcher
seam, but the fully tested path is local.

**Status: IMPLEMENTED (software-tested infrastructure).** There is no hosted
registry service in this repository, and this package does not claim one. The
trust model reuses `@pinout/module-host` hashing and signing byte-for-byte.

## What this actually guarantees

- **Strict index format** — `registry.json` is validated field by field;
  unknown fields and duplicate `(name, version)` entries are rejected.
- **Hash parity with module-host** — `manifestHash` / `contentHash` are
  delegated to `@pinout/module-host`, so an entry verifies with the same bytes
  as `pinout module sign` / `pinout module verify`.
- **Real signature checks** — Ed25519 over `${manifestHash}:${contentHash}`
  (the module-host payload), verified with `node:crypto` at install time.
- **Atomic installs** — payloads are materialized into a temp directory inside
  the target, verified, then renamed into place. Failures clean up after
  themselves.
- **No level inflation** — `pack` defaults to `status: "UNVERIFIED"`. L0–L5
  statuses are recorded only from evidence (see conformance below).

## What this does NOT guarantee (read this)

- **No hosted registry, no dependency resolution, no signing service.** Keys
  are passed in by the caller; the package never reads a key store.
- **No sandboxing.** Installing a module does not make its code safe to run.
  Verification proves *provenance and integrity*, not intent.
- **A signature proves what it covers.** The registry records a publisher id
  next to a signature; publisher ids are claims, not registered identities.
  Scoped allowlists are the only way to bind a key to a name.
- **v0 rejects rather than repairs**: strict schema, strict semver subset
  (`*`, `x.y.z`, `^x.y.z`, `~x.y.z`), strict payload documents.

## Index format (v0)

```json
{
  "schemaVersion": 1,
  "name": "acme-registry",
  "modules": [
    {
      "name": "vendor/module",
      "version": "1.2.3",
      "description": "Human description",
      "publisher": "vendor",
      "manifestHash": "<64 lowercase hex sha256>",
      "contentHash": "<64 lowercase hex sha256>",
      "signature": "<base64 Ed25519 of `${manifestHash}:${contentHash}`>",
      "status": "L2",
      "targets": ["node"],
      "url": "modules/vendor-module@1.2.3",
      "publishedAt": "2026-10-17T00:00:00.000Z"
    }
  ]
}
```

Rules:

- All fields are required except index `name`/`updatedAt` and entry
  `publisher`/`signature`.
- `publisher` and `signature` must appear together.
- `name` matches `vendor/name` (lowercase letters, digits, hyphens);
  `version` is a full semantic version.
- Hashes are lowercase SHA-256 hex; `signature` is base64 of a 64-byte
  Ed25519 signature (86 chars + `==`).
- `status` is a conformance level (`L0`…`L5`) or `UNVERIFIED`. It is
  deliberately not the manifest `status` vocabulary
  (`CANDIDATE`/`REVIEWED`/`TESTED`): the manifest records review state, the
  registry records tested evidence and never inflates.
- `targets` is a non-empty list of free-form labels (`node`, `esp32`, …).
- `url` is resolved relative to the index location: an absolute URL, a
  `file:` URL, an absolute path, or a path relative to the index directory.
- Unknown fields are rejected. Format changes must be deliberate.

## Trust model

Hashes and signatures are the module-host algorithms:

```
manifestHash = sha256(canonical JSON of pinout.module.json)
contentHash  = sha256("rel/path:<sha256>\n…" over the module directory,
                      ignoring node_modules, dist, .git, coverage,
                      .pinout-cache, pinout.module.sig)
signature    = Ed25519(manifestHash + ":" + contentHash)
```

`pinout module install` writes the received signature into the installed
directory as a standard `pinout.module.sig`, so `@pinout/module-host` can
verify installed copies without the registry.

Trust policy:

- By default unsigned entries are allowed locally and clearly labeled
  `ABSENT`; they are never reported as verified.
- `requireSignature` fails unsigned entries and entries without a usable
  trusted key.
- An allowlist key **without** a `publisher` is a wildcard: it vouches for the
  key regardless of the claimed publisher id. An allowlist key **with** a
  `publisher` only applies to that id.

## Conformance levels (L0–L5)

Levels come from `@pinout/module-host`:

| Level | Name | Evidence |
| ----- | ---- | -------- |
| L0 | MANIFEST_VALID | manifest parses and validates |
| L1 | BUILDS | entrypoint loads and matches the manifest |
| L2 | CONFORMANCE_PASS | `runModuleConformance` (core kit) passes |
| L3 | SIMULATION_VERIFIED | simulation evidence |
| L4 | INTEGRATION_VERIFIED | daemon/module-host integration evidence |
| L5 | HARDWARE_VERIFIED | dated hardware record |

`evaluateModuleConformance` runs the software-testable checks itself and reads
L3+ *evidence* from `evidence/conformance.json` (strict format) or from
explicit options. Simulation is not hardware; absence of evidence keeps the
level honest.

```json
{
  "schemaVersion": 1,
  "simulationVerified": true,
  "integrationVerified": false,
  "hardwareRecord": {
    "date": "2026-09-08",
    "hardware": "ESP32 classic DevKit",
    "firmwareVersion": "0.0.1-alpha.1",
    "moduleVersion": "1.0.0",
    "testSuiteVersion": "0.1.0"
  }
}
```

## Remote payload protocol (v0)

A remote entry URL points at a payload document, `/payload.json` appended when
the URL does not already end in `.json`:

```json
{ "schemaVersion": 1, "files": ["pinout.module.json", "dist/index.js"] }
```

Files are fetched relative to the document. Only safe relative POSIX paths are
accepted, `pinout.module.json` is mandatory, and excluded directories
(`node_modules`, `.git`, `coverage`, `.pinout-cache`) may not be listed.
Local payloads may be a module directory (copied with the pack rules) or a
`payload.json` document.

## CLI (in `@pinout/cli`)

```bash
pinout module pack <dir> [--sign-key key.pem --publisher <id>] [--status L2] [--url <u>] [--target <t>] [--out entry.json]
pinout module publish <dir> --registry <index-or-dir> [--dry-run] [--replace] [--index <file>] [--sign-key … --publisher …]
pinout module search <query> --registry <source>
pinout module info <name[@range]> --registry <source>
pinout module install <name[@range]> --registry <source> [--out <dir>] [--force] [--require-signature] [--allow-publisher [id=]key.pem]
pinout module verify <dir> --registry <source> [--name <id>] [--version <range>] [--require-signature] [--allow-publisher …]
pinout module conformance <dir> [--json <file>] [--simulation-verified] [--integration-verified] [--hardware-record <file>]
```

`publish` copies the payload into `<index-dir>/modules/<vendor-name>@<version>`
unless `--url` says the publisher hosts it, then verifies the entry against
the copied bytes before appending to the index. `install` defaults to
`<PINOUT_HOME>/registry-modules/<vendor>__<name>@<version>`. Registry
installations are vendored copies; register them with the runtime via
`pinout module install <path>`.

## Library surface

```ts
import {
  RegistryClient,      // load/resolve/search a local or remote index
  packModule,          // entry + file list from a module directory
  appendEntry, upsertEntry,
  verifyEntry,         // hash + signature report
  installModule,       // resolve → materialize → verify → rename
  evaluateModuleConformance,
  createPayloadSigner, // inject signing; no key store
} from '@pinout/registry';
```

## Testing

```bash
npm install          # links workspace packages
npm run build        # tests resolve @pinout/registry / @pinout/module-host via dist
npm test -- packages/registry packages/cli packages/generator
```

All tests are offline and deterministic (temp directories, fake fetchers,
fixed timestamps where the API allows injection).
