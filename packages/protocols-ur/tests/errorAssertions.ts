import { expect } from 'vitest';

/**
 * Assert that a synchronous call throws a structured error carrying `code`.
 * Protocols expose stable codes on the error object; message prose is not a
 * contract.
 */
export function expectErrorCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected an error with code '${code}', but no error was thrown.`);
}
