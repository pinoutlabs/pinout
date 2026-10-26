/**
 * OpenAI-compatible function names must match ^[a-zA-Z0-9_-]+$.
 * Pinout capability tools use dots (gpio.write). Encode for the LLM and
 * resolve by matching against the encoded form of each registered tool name
 * (do not naively reverse __ -> . ; names like pinout__list_devices already
 * contain underscores).
 */

export function encodeToolNameForLlm(name: string): string {
  return name.replace(/\./g, '__');
}

export function resolveEncodedToolName(
  llmName: string,
  registeredNames: Iterable<string>,
): string | undefined {
  for (const name of registeredNames) {
    if (name === llmName || encodeToolNameForLlm(name) === llmName) {
      return name;
    }
  }
  return undefined;
}
