/**
 * Honest temperature policy: some OpenAI reasoning-family models reject the
 * temperature field. When we omit it, records must say "model default" rather
 * than claiming a numeric value that was never sent.
 */

export type TemperatureRecord = number | 'model default';

export function modelOmitsTemperature(modelId: string): boolean {
  return /^(o\d|gpt-5|gpt-6)/i.test(modelId);
}

/**
 * Resolve what to send on the wire and what to record.
 * - If the model omits temperature: never send it; record "model default"
 *   (even if the operator passed --temperature, which cannot be applied).
 * - Otherwise: send the requested value (default 0 when explicitly configured)
 *   and record that same number.
 */
export function resolveTemperaturePolicy(options: {
  modelId: string;
  requested: number | undefined;
  temperatureExplicitlySet: boolean;
}): { send: number | undefined; record: TemperatureRecord; note?: string } {
  if (modelOmitsTemperature(options.modelId)) {
    const note = options.temperatureExplicitlySet
      ? `Model ${options.modelId} rejects temperature; request omitted and recorded as model default.`
      : undefined;
    return note
      ? { send: undefined, record: 'model default', note }
      : { send: undefined, record: 'model default' };
  }
  const value = options.requested ?? 0;
  return { send: value, record: value };
}
