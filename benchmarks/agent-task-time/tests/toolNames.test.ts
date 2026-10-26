import { describe, expect, it } from 'vitest';
import { encodeToolNameForLlm, resolveEncodedToolName } from '../src/llm/toolNames.js';

describe('tool name codec', () => {
  it('encodes dots for OpenAI-compatible function names', () => {
    expect(encodeToolNameForLlm('gpio.write')).toBe('gpio__write');
    expect(encodeToolNameForLlm('sys.arm')).toBe('sys__arm');
    expect(encodeToolNameForLlm('pinout__list_devices')).toBe('pinout__list_devices');
  });

  it('resolves encoded names without breaking underscore control-plane tools', () => {
    const registered = ['gpio.write', 'sys.arm', 'pinout__list_devices', 'compile_flash'];
    expect(resolveEncodedToolName('gpio__write', registered)).toBe('gpio.write');
    expect(resolveEncodedToolName('sys__arm', registered)).toBe('sys.arm');
    expect(resolveEncodedToolName('pinout__list_devices', registered)).toBe(
      'pinout__list_devices',
    );
    expect(resolveEncodedToolName('compile_flash', registered)).toBe('compile_flash');
    expect(resolveEncodedToolName('missing', registered)).toBeUndefined();
  });
});
