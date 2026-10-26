#!/usr/bin/env node
import { parseCliArgs } from './config.js';
import { runHarness } from './harness.js';
import { redactSecrets } from './redact.js';

async function main(): Promise<void> {
  const config = parseCliArgs(process.argv.slice(2));
  if (config.scriptedAgent) {
    console.log(
      'HARNESS_TEST_NOT_LLM: running deterministic scripted agent (not an LLM result).',
    );
  } else {
    console.log(
      redactSecrets(
        `Starting SIMULATED agent task-time bench: provider=${config.provider} model=${config.model} runs=${config.runs}`,
      ),
    );
  }

  const { summary, outputDir } = await runHarness(config);
  console.log(redactSecrets(`Wrote results to ${outputDir}`));
  console.log(redactSecrets(`Evidence: ${summary.evidence}`));
  console.log(redactSecrets(`Cells: ${summary.cells.length}; runs kept: ${summary.runs.length}`));
  console.log(redactSecrets(summary.note));
}

main().catch((error) => {
  console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
