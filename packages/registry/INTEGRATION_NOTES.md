# @pinout/registry — integration notes

Handoff notes for the repository integrator. Everything below is either a
change this package deliberately did **not** make (out of its file ownership)
or a gap another package should close later.

## 1. Repository wiring

Done by this change:

- `packages/cli/package.json` declares `@pinout/registry: 0.0.1-alpha.1`.
- `packages/cli/tsconfig.json` references `../registry`.
- `packages/registry/tsconfig.json` references `../core` and `../module-host`.
- `packages/cli/src/runCli.ts` registers the new commands on the existing
  `module` command; `pinoutHomeCommands.ts` / `moduleIntegrityCommands.ts`
  gained additive `--registry` flows.

Pending for the integrator (root-config files are outside this change's
ownership):

1. **Root `tsconfig.json`** — add `{ "path": "packages/registry" }` to
   `references`. Without it, `npm run typecheck` / `tsc -b` at the root will
   not build the new package, and `packages/cli`'s reference to it will fail
   project-reference resolution. (Adding `packages/registry` alone is enough;
   `packages/cli` already references it.)
2. **`package-lock.json`** — run `npm install` to link the new workspace
   package (`workspaces: ["packages/*"]` already covers it). No new external
   runtime dependencies were added: `@pinout/core` and `@pinout/module-host`
   are workspace deps; everything else is a Node built-in.
3. **vitest** — `vitest.config.ts` aliases only `@pinout/core` and
   `@pinout/generator`; `@pinout/module-host` and the new `@pinout/registry`
   resolve through workspace symlinks to built `dist`. This is consistent
   with the existing CLI/module-host tests, and `npm test` runs `pretest`
   (full build) first, so no change is required. Optional: add
   `@pinout/registry` and `@pinout/module-host` aliases to `src` for
   alias-only test runs.
4. `tsconfig.test.json` already includes `packages/*/tests/**/*.ts`, so the
   new tests are covered by `npm run typecheck:tests`.

## 2. `@pinout/core` export gap

`packages/core/src/module/validate.ts` contains `assertValidModuleId`,
`assertValidSemver`, and `compareSemver`, but core's `src/index.ts` does not
export them. The registry therefore:

- validates module ids with its own pattern (`MODULE_ID_PATTERN` in
  `src/indexFormat.ts`, a deliberate copy of core's grammar),
- implements its own strict semver subset in `src/semver.ts` (`*`,
  `x.y.z`, `^x.y.z`, `~x.y.z` only — stricter than core's helper on purpose).

If core exports these helpers later, the registry can delegate id/semver
*parsing*; keep the range grammar local because it is a registry-v0 contract.

## 3. `@pinout/module-host` payload verification gap

Module-host exposes directory-level verification (`verifyModule(dir)` reading
`pinout.module.sig`) but no primitive that verifies a signature over
`${manifestHash}:${contentHash}` from raw bytes. Registry entries carry the
signature in the index, so `src/verify.ts` uses `node:crypto` directly with
the exact module-host payload. Interop is pinned by tests in both directions:

- `createPayloadSigner(privateKey)` output === `signModule(...).signature`
  (`packages/registry/tests/verify.test.ts`, `publish.test.ts`).
- Installed `pinout.module.sig` files verify with module-host
  `verifyModule()` (`packages/registry/tests/install.test.ts`).

If module-host later exports a payload-level verify helper, registry should
switch to it and delete the duplicated `node:crypto` call.

## 4. Hash/copy ignore-rule invariant (do not violate)

- Hash exclusions (module-host): `node_modules`, `dist`, `.git`, `coverage`,
  `.pinout-cache`, `pinout.module.sig`.
- Copy/install exclusions (registry): `node_modules`, `.git`, `coverage`,
  `.pinout-cache`.

Copy exclusions must stay a strict subset — anything dropped before
installation but hashed before packing would make installs unverifiable.
`dist` is intentionally copied because generated modules point their
entrypoint at `./dist/index.js`. If module-host changes its exclusion list,
update `PACK_EXCLUDED_DIRECTORIES`/`HASH_EXCLUDED_DIRECTORIES` in
`src/content.ts` and the copy in
`packages/generator/src/registryCompat.ts`.

## 5. Status vocabulary

The registry `status` field is `L0`…`L5` or `UNVERIFIED` (module-host
`CONFORMANCE_LEVELS`), not the manifest status `CANDIDATE`/`REVIEWED`/
`TESTED`. Rationale: manifest status is review metadata; the registry field
records tested evidence and never inflates (packing defaults to
`UNVERIFIED`; `--status` is an explicit publisher claim). If a catalog/docs
surface adopts registry statuses, align the vocabulary there — this change
touched neither `hardware/catalog.json` nor `docs/`.

`hardware/catalog.json` contains no registry protocol note (grepped); the
registry format is documented only in `packages/registry/README.md`.

## 6. Intentional duplication

`packages/generator/src/registryCompat.ts` duplicates the registry pack
contract (required entries, excluded directories) instead of importing
`@pinout/registry`, because the CLI → generator → registry dependency
direction makes an import from the generator a cycle risk and the registry
must not depend on the generator. `packages/generator/tests/registryCompat.test.ts`
pins the exclusion list; if the registry list changes, update both files.

## 7. CLI behavior notes

- Registrations are additive: `module pack|publish|search|info|conformance`
  are new subcommands; `module install` and `module verify` keep their legacy
  behavior unless `--registry` is passed.
- `module conformance --json <file>` coexists with the global `--json` flag;
  the global flag must come before `module` (`pinout --json module conformance …`).
- `module verify`'s legacy `--publisher id=path.pem` and the registry
  `--allow-publisher [id=]path.pem` are merged into one allowlist when
  `--registry` is used.
- `install --force` re-verifies before replacing; a failed verification keeps
  the previous installation intact and removes the temp directory.
- `publish` appends to `<index-dir>/registry.json` by default; `--index`
  overrides. Publishing requires a local index (remote sources fail with
  `REGISTRY_READ_ONLY`).
- Registry installs land in `<PINOUT_HOME>/registry-modules/` by default and
  are vendored copies; users still register them with the runtime via
  `pinout module install <path>`.

## 8. Docs to update (not touched by this change)

- `docs/cli.md` — add a "Module registry" section for the commands above.
- `docs/modules.md` — link the L0–L5 trust ladder to registry statuses and
  the evidence file format.
- `docs/index.md` / root `README.md` — package list now includes
  `@pinout/registry`.

## 9. Uncertainties / unverified in this change

- `npm install` / `npm run build` / `npm test` could not be executed here
  (no `node_modules`); all type checks were manual. Run the root scripts
  first after wiring the root tsconfig reference (section 1.1).
- Conformance tests load throwaway module directories from the OS temp dir
  via dynamic `import()` (core `loadModuleFromDirectory`). Their fixtures are
  plain ESM with no imports so vite-node handles them, but this path is only
  exercised once tests actually run.
- The default install directory (`<PINOUT_HOME>/registry-modules`) is covered
  by a CLI test that overrides `PINOUT_HOME`; the true user home is never
  written to by tests.
