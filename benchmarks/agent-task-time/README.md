# Agent task-time benchmark (raw vs Pinout)

Honest, reproducible wall-clock comparison of an LLM agent completing the **same**
SIMULATED hardware tasks in two arms:

| Arm | What the agent gets |
| --- | --- |
| **A `raw`** | No Pinout. Shell-like workspace, datasheet-style board/serial docs, must write and `compile_flash` a firmware sketch (plus optional serial requests). |
| **B `pinout`** | Pinout MCP/SDK-shaped tools (`packages/mcp` capability surface / `toAgentTools`), discovers devices and invokes capabilities. |

Every automatic success check reads **device GPIO / servo / ADC journal state**, never the model’s own claim. Every default result is labelled **SIMULATED**.

> **No LLM results have been produced in this tree yet.** The Results table section below stays empty until someone runs the real command and commits the generated files under `results/<date>/`.

## Prerequisites

- Node.js **22** (also works on Node `>=20`; CI/dev images commonly use 22)
- Repository dependencies: from the repo root, `npm install` and `npm run build`
- For a real LLM run: an API key for your provider (`OPENAI_API_KEY`, or `ANTHROPIC_API_KEY`, or `PINOUT_BENCH_API_KEY`)

## Exact command (real LLM)

From a clean checkout at the repo root:

```bash
npm install
npm run build
PINOUT_BENCH_PROVIDER=openai PINOUT_BENCH_MODEL=gpt-6.1-sol OPENAI_API_KEY=... \
  npm run bench:agent -- --runs 5
```

Optional spend guards:

```bash
PINOUT_BENCH_PROVIDER=openai PINOUT_BENCH_MODEL=gpt-6.1-sol OPENAI_API_KEY=... \
  npm run bench:agent -- --runs 5 --budget-usd 5 --max-tokens 500000
```

Outputs (always generated from the run; never hand-edit):

- `benchmarks/agent-task-time/results/<date>/runs/*.json` - full per-run records + transcripts
- `benchmarks/agent-task-time/results/<date>/summary.json`
- `benchmarks/agent-task-time/results/<date>/RESULTS.md` - markdown table
- `benchmarks/agent-task-time/results/<date>/config.redacted.json` - config with API key removed

Regenerate the markdown table from an existing summary (still not hand-edited):

```bash
npm run bench:agent:markdown -- benchmarks/agent-task-time/results/<date>/summary.json
```

## Harness self-test only (not a result)

```bash
npm run bench:agent -- --dry-run --runs 1 --profiles esp32 --tasks blinkLed
```

Dry-run / `--scripted-agent` uses a deterministic fake agent. Artifacts are stamped
`HARNESS_TEST_NOT_LLM` and **must not be reported as LLM benchmark numbers**.

## Tasks (same intent in both arms)

1. **blinkLed** - drive the profile LED pin high then low (journal check)
2. **servoSweep** - servo to 90°, then back to 0° within 0-180 (journal check)
3. **readSensor** - ADC read on the profile sensor pin (journal check)

Profiles: `esp32` (repo `simulatedEsp32`), `pico`, `uno` (protocol-compatible SIMULATED boards).

## How to add a model

1. Set `PINOUT_BENCH_PROVIDER` (`openai`, `openai-compatible`, `anthropic`, …)
2. Set `PINOUT_BENCH_MODEL` to the exact model id you want recorded
3. Set the matching API key env var
4. Optionally set `PINOUT_BENCH_API_BASE_URL` for OpenAI-compatible proxies
5. Re-run `npm run bench:agent -- --runs N`
6. Commit the new `results/<date>/` directory produced by the harness

The harness records the **model string returned by the API**, provider, temperature,
tool lists, harness git SHA, OS, Node version, and timestamps.

## Interpreting results

- Compare **median** and **p90** wall-clock per arm × task × profile
- Always read **success rate**; failures and timeouts are kept, never dropped
- `llmTimeMs` vs `toolTimeMs` separates model latency from tool/simulator time
- If Pinout is not faster, the generated table will show that. There are no
  hard-coded target times in this harness.

## Real hardware hook (not yet run)

```bash
npm run bench:agent -- --device real
```

`--device real` is reserved for a future board path. It is **documented and
rejected until implemented**. No real-hardware numbers exist yet.

## API key safety

- Keys are read from env only
- Transcripts, `summary.json`, `RESULTS.md`, and `config.redacted.json` redact
  key material before write
- The writer refuses to flush artifacts that still contain a configured secret

## Limitations

- Default path is **SIMULATED** (in-process ESP32 simulator / bench board profiles)
- Early test harness: measures agent task wall-clock on simulators, not production fleet hardware
- Scripted dry-run output is **not** an LLM result
- Budget USD estimates use configurable price hints; they are not a vendor invoice

## Tests

```bash
npm run test -- benchmarks/agent-task-time/tests
npm run typecheck:bench
```

## Results table

_No LLM results have been produced yet. After a real run, paste or include the
generated `results/<date>/RESULTS.md` content here (or link that file). Do not
hand-author numbers._
