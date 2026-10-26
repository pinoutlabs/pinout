import { afterEach, describe, expect, it } from 'vitest';
import { assertNoSecretLeak, redactSecrets } from '../src/redact.js';

const originalKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
});

describe('secret redaction', () => {
  it('redacts configured API keys from text', () => {
    process.env.OPENAI_API_KEY = 'sk-test-secret-value-123456';
    const text = redactSecrets('Authorization Bearer sk-test-secret-value-123456 done');
    expect(text).not.toContain('sk-test-secret-value-123456');
    expect(text).toContain('[REDACTED]');
  });

  it('redacts sk- shaped tokens even without env', () => {
    const text = redactSecrets('token sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
  });

  it('assertNoSecretLeak throws when a secret remains', () => {
    process.env.OPENAI_API_KEY = 'sk-test-secret-value-123456';
    expect(() => assertNoSecretLeak('leak sk-test-secret-value-123456')).toThrow(/secret/i);
  });
});
