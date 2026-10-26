/** Strip secrets from anything that might be written to disk or stdout. */

const SECRET_ENV_NAMES = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'PINOUT_BENCH_API_KEY',
  'PINOUT_GENERATOR_API_KEY',
  'PINOUT_TOKEN',
] as const;

const KEYISH_PATTERN =
  /(?:sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,})/g;

const KEY_FIELD_PATTERN =
  /("?(?:api[_-]?key|authorization|token|secret|password)"?\s*[:=]\s*")([^"]+)(")/gi;

export function collectSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values: string[] = [];
  for (const name of SECRET_ENV_NAMES) {
    const value = env[name];
    if (value && value.length >= 8) values.push(value);
  }
  return values;
}

export function redactSecrets(input: string, extraSecrets: string[] = []): string {
  let output = input;
  const secrets = [...collectSecretValues(), ...extraSecrets].filter((value) => value.length >= 8);
  for (const secret of secrets) {
    output = output.split(secret).join('[REDACTED]');
  }
  output = output.replace(KEYISH_PATTERN, '[REDACTED]');
  output = output.replace(KEY_FIELD_PATTERN, '$1[REDACTED]$3');
  return output;
}

export function redactJsonValue<T>(value: T, extraSecrets: string[] = []): T {
  return JSON.parse(redactSecrets(JSON.stringify(value), extraSecrets)) as T;
}

export function assertNoSecretLeak(text: string, extraSecrets: string[] = []): void {
  const secrets = [...collectSecretValues(), ...extraSecrets].filter((value) => value.length >= 8);
  for (const secret of secrets) {
    if (text.includes(secret)) {
      throw new Error('Refusing to write output that still contains a configured API secret.');
    }
  }
}
