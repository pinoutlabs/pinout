/**
 * Deliberately small semver subset for registry v0.
 *
 * Supported version strings: full semantic versions
 * (`x.y.z`, optional `-prerelease`, optional `+build`). Build metadata is
 * ignored for comparisons, matching common semver behavior.
 *
 * Supported range grammar (nothing else is accepted):
 *   `*`        any release version (pre-releases never match `*`)
 *   `x.y.z`    exact version (pre-release must match exactly)
 *   `^x.y.z`   >= x.y.z and < next breaking version
 *              (major bump when x > 0; minor bump when x = 0, y > 0;
 *               patch bump when x = 0 and y = 0)
 *   `~x.y.z`   same major.minor, >= x.y.z and < x.(y+1).0
 *
 * Partial ranges (`1`, `1.2`), `>=`-style ranges, `||`, and pre-release range
 * tags (`^1.2.3-beta`) are intentionally not part of v0: the registry must stay
 * boring and comparable across implementations.
 */

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.-]+))?(?:\+[a-zA-Z0-9.-]+)?$/;

export function parseSemver(value: string): ParsedSemver | null {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) return null;
  const major = match[1];
  const minor = match[2];
  const patch = match[3];
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
    prerelease: match[4] ?? null,
  };
}

export function isValidSemver(value: string): boolean {
  return parseSemver(value) !== null;
}

/** Releases sort after their own pre-releases; pre-releases sort lexically. */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return a.localeCompare(b);
  for (const key of ['major', 'minor', 'patch'] as const) {
    const diff = left[key] - right[key];
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  const diff = left.prerelease.localeCompare(right.prerelease);
  return diff === 0 ? 0 : diff < 0 ? -1 : 1;
}

export type VersionRange =
  | { kind: 'any' }
  | { kind: 'exact'; version: string }
  | { kind: 'caret'; version: string }
  | { kind: 'tilde'; version: string };

export function parseVersionRange(range: string): VersionRange | null {
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*') return { kind: 'any' };
  const operator = trimmed[0];
  if (operator === '^' || operator === '~') {
    const version = trimmed.slice(1);
    if (parseSemver(version) === null) return null;
    if (version.includes('-')) return null;
    return operator === '^' ? { kind: 'caret', version } : { kind: 'tilde', version };
  }
  if (parseSemver(trimmed) !== null) return { kind: 'exact', version: trimmed };
  return null;
}

export function isValidRange(range: string): boolean {
  return parseVersionRange(range) !== null;
}

export function satisfiesRange(version: string, range: string): boolean {
  const parsedRange = parseVersionRange(range);
  const parsedVersion = parseSemver(version);
  if (!parsedRange || !parsedVersion) return false;
  switch (parsedRange.kind) {
    case 'any':
      return parsedVersion.prerelease === null;
    case 'exact':
      return compareSemver(version, parsedRange.version) === 0;
    case 'caret': {
      if (parsedVersion.prerelease !== null) return false;
      const base = parseSemver(parsedRange.version);
      if (!base) return false;
      if (compareSemver(version, parsedRange.version) < 0) return false;
      const upper = caretUpperBound(base);
      return compareSemver(version, upper) < 0;
    }
    case 'tilde': {
      if (parsedVersion.prerelease !== null) return false;
      const base = parseSemver(parsedRange.version);
      if (!base) return false;
      if (compareSemver(version, parsedRange.version) < 0) return false;
      const upper = `${base.major}.${base.minor + 1}.0`;
      return compareSemver(version, upper) < 0;
    }
  }
}

function caretUpperBound(base: ParsedSemver): string {
  if (base.major > 0) return `${base.major + 1}.0.0`;
  if (base.minor > 0) return `0.${base.minor + 1}.0`;
  return `0.0.${base.patch + 1}`;
}

/** Highest version from `candidates` that satisfies `range`, or null. */
export function selectBestVersion(candidates: string[], range: string): string | null {
  let best: string | null = null;
  for (const candidate of candidates) {
    if (!satisfiesRange(candidate, range)) continue;
    if (best === null || compareSemver(candidate, best) > 0) best = candidate;
  }
  return best;
}
