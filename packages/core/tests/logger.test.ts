import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger.js';

describe('createLogger', () => {
  it('redacts payload, secret, and token fields', () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const logger = createLogger('info');
      logger.info('wrote', { requestId: 'abc', payload: { pin: 2 }, token: 's3cret' });
      expect(info).toHaveBeenCalledTimes(1);
      const line = String(info.mock.calls[0]?.[0]);
      expect(line).toContain('requestId');
      expect(line).toContain('[redacted]');
      expect(line).not.toContain('s3cret');
    } finally {
      info.mockRestore();
    }
  });

  it('suppresses debug when level is info', () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const logger = createLogger('info');
      expect(logger.isEnabled('debug')).toBe(false);
      expect(logger.isEnabled('info')).toBe(true);
      logger.debug('hidden', { action: 'gpio.write' });
      expect(info).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });
});
