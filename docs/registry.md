# Module registry

Pinout modules can be shared through an **offline-first registry**: a plain JSON
index plus module payloads, verified by content hashes and optional Ed25519
publisher signatures. There is no hosted service requirement — a directory on
your machine is a valid registry, and HTTPS indexes are supported through the
same client.

Status: `IMPLEMENTED` (offline unit tests; no live registry service exists).

## Index format (`registry.json`, schemaVersion 1)

```json
{
  "schemaVersion": 1,
  "name": "acme-registry",
  "updatedAt": "2026-10-17T00:00:00.000Z",
  "modules": [
    {
      "name": "vendor/module",
      "version": "1.2.3",
      "description": "What the module controls",
      "publisher": "vendor",
      "manifestHash": "<64 hex chars>",
      "contentHash": "<64 hex chars>",
      "signature": "<base64 Ed25519 over manifestHash:contentHash>",
      "status": "L2",
      "targets": ["node"],
      "url": "modules/vendor-module@1.2.3",
      "publishedAt": "2026-10-17T00:00:00.000Z"
    }
  ]
}
```

- Validation is strict: unknown fields, duplicate `(name, version)` pairs, and
  malformed hashes/signatures are rejected.
- `publisher` and `signature` must appear together.
- `status` records the **tested evidence level** (`L0`–`L5`, or `UNVERIFIED`) —
  never a claim of review. Packing defaults to `UNVERIFIED`; only conformance
  runs and dated hardware records justify higher levels.
- A remote payload is described by `<url>/payload.json` (or a direct `.json`)
  listing safe relative POSIX paths; `pinout.module.json` is mandatory.

## Trust model

- `contentHash` / `manifestHash` use the same algorithms as
  `@pinout/module-host`; signatures cover `${manifestHash}:${contentHash}` and
  are byte-compatible with module-host signing.
- Install requires hash verification always; `--require-signature` demands a
  valid Ed25519 signature, and `--allow-publisher <id>=<pem>` pins accepted
  publishers (scoped or wildcard).
- Unsigned modules work in development and are never displayed as verified.

## CLI workflow

```bash
# Package a module directory into a registry entry
pinout module pack ./my-device --out ./entry.json

# Publish into a local registry (index + payload copy)
pinout module publish ./my-device --registry ./registry

# Discover and inspect
pinout module search "temperature" --registry ./registry
pinout module info vendor/module --registry ./registry

# Verified install into an explicit directory
pinout module install vendor/module --registry ./registry \
  --out ./modules --require-signature

# Verify an installed directory against the registry entry
pinout module verify ./modules/vendor__module@1.2.3 \
  --registry ./registry --name vendor/module

# Machine-readable L0–L5 conformance report
pinout module conformance ./my-device --json ./conformance.json
```

See [`packages/registry/README.md`](../packages/registry/README.md) for the
API, and [`docs/modules.md`](modules.md) for how modules fit into the runtime.
