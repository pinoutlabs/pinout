import { describe, expect, it } from 'vitest';
import {
  compareSemver,
  isValidRange,
  parseSemver,
  satisfiesRange,
  selectBestVersion,
} from '../src/semver.js';

describe('semver subset', () => {
  it('parses full versions and ignores build metadata', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
    expect(parseSemver('1.2.3+build.5')?.patch).toBe(3);
    expect(parseSemver('1.2.3-beta.1')?.prerelease).toBe('beta.1');
    expect(parseSemver('1.2')).toBeNull();
    expect(parseSemver('v1.2.3')).toBeNull();
  });

  it('compares numerically and puts releases after pre-releases', () => {
    expect(compareSemver('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '1.0.0-beta')).toBeGreaterThan(0);
    expect(compareSemver('2.0.0', '2.0.0')).toBe(0);
  });

  it('supports the documented range grammar', () => {
    expect(isValidRange('*')).toBe(true);
    expect(isValidRange('1.2.3')).toBe(true);
    expect(isValidRange('^1.2.3')).toBe(true);
    expect(isValidRange('~1.2.3')).toBe(true);
    expect(isValidRange('>=1.2.3')).toBe(false);
    expect(isValidRange('1.2')).toBe(false);
    expect(isValidRange('^1.2')).toBe(false);
    expect(isValidRange('^1.2.3-beta')).toBe(false);
    expect(isValidRange('')).toBe(false);
  });

  it('matches caret ranges with npm-style zero-major semantics', () => {
    expect(satisfiesRange('1.9.0', '^1.2.3')).toBe(true);
    expect(satisfiesRange('2.0.0', '^1.2.3')).toBe(false);
    expect(satisfiesRange('1.2.2', '^1.2.3')).toBe(false);
    expect(satisfiesRange('0.2.9', '^0.2.3')).toBe(true);
    expect(satisfiesRange('0.3.0', '^0.2.3')).toBe(false);
    expect(satisfiesRange('0.0.3', '^0.0.3')).toBe(true);
    expect(satisfiesRange('0.0.4', '^0.0.3')).toBe(false);
  });

  it('matches tilde ranges within the same major.minor', () => {
    expect(satisfiesRange('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfiesRange('1.3.0', '~1.2.3')).toBe(false);
    expect(satisfiesRange('1.2.2', '~1.2.3')).toBe(false);
  });

  it('never matches pre-releases for *, ^, or ~', () => {
    expect(satisfiesRange('2.0.0-beta.1', '*')).toBe(false);
    expect(satisfiesRange('1.5.0-beta.1', '^1.2.3')).toBe(false);
    expect(satisfiesRange('1.2.9-beta.1', '~1.2.3')).toBe(false);
  });

  it('matches exact versions including pre-releases', () => {
    expect(satisfiesRange('1.2.3', '1.2.3')).toBe(true);
    expect(satisfiesRange('1.2.3+build', '1.2.3')).toBe(true);
    expect(satisfiesRange('1.2.4', '1.2.3')).toBe(false);
    expect(satisfiesRange('1.2.3-beta.1', '1.2.3-beta.1')).toBe(true);
    expect(satisfiesRange('1.2.3-beta.1', '1.2.3')).toBe(false);
  });

  it('selects the best matching version', () => {
    const versions = ['0.1.0', '0.2.0', '1.0.0', '1.1.0', '2.0.0'];
    expect(selectBestVersion(versions, '*')).toBe('2.0.0');
    expect(selectBestVersion(versions, '^0.1.0')).toBe('0.2.0');
    expect(selectBestVersion(versions, '~1.0.0')).toBe('1.0.0');
    expect(selectBestVersion(versions, '0.1.0')).toBe('0.1.0');
    expect(selectBestVersion(versions, '^3.0.0')).toBeNull();
  });
});
