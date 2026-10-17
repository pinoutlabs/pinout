import { describe, expect, it } from 'vitest';
import { LibgpiodError } from '../src/errors.js';
import {
  normalizeChipName,
  parseGpiodetectOutput,
  parseGpioinfoOutput,
  parseGpiogetValues,
  parseGpiomonLine,
} from '../src/parser.js';
import { GpioTools, type GpioWatchEvent } from '../src/tools.js';
import { FakeCommandRunner } from './fakeRunner.js';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function makeTools(runner: FakeCommandRunner, startupGraceMs = 0): GpioTools {
  return new GpioTools({ runner, platform: 'linux', startupGraceMs });
}

const realGpioinfo = [
  'gpiochip0 - 54 lines:',
  '\tline   0: unnamed input',
  '\tline   1: "ID_SDA" input bias=pull-up',
  '\tline   2: "PWR_LED_OFF" output active-low consumer="led1"',
  '\tline  17:\t"GPIO17"\t"led"\toutput\tactive-high\t[used]',
].join('\n');

describe('libgpiod output parsers', () => {
  it('parses gpiodetect output into chip records', () => {
    const chips = parseGpiodetectOutput(
      'gpiochip0 [pinctrl-rp1] (54 lines)\ngpiochip1 [gpio-brcmstb] (1 line)\n',
    );
    expect(chips).toHaveLength(2);
    expect(chips[0]).toMatchObject({ name: 'gpiochip0', label: 'pinctrl-rp1', lineCount: 54 });
    expect(chips[1]).toMatchObject({ name: 'gpiochip1', lineCount: 1 });
  });

  it('refuses unrecognized gpiodetect output instead of dropping a chip', () => {
    try {
      parseGpiodetectOutput('gpiochip0 pinctrl-rp1 54 lines');
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect((error as LibgpiodError).code).toBe('GPIO_OPERATION_FAILED');
      expect((error as LibgpiodError).details).toMatchObject({
        phase: 'parse',
        tool: 'gpiodetect',
      });
    }
  });

  it('parses both v2 and legacy gpioinfo line forms', () => {
    const info = parseGpioinfoOutput(realGpioinfo);
    expect(info.chips).toEqual([
      expect.objectContaining({ name: 'gpiochip0', lineCount: 54 }),
    ]);
    expect(info.unparsed).toEqual([]);
    expect(info.lines).toHaveLength(4);

    const unnamed = info.lines[0]!;
    expect(unnamed).toMatchObject({
      chip: 'gpiochip0',
      offset: 0,
      name: null,
      direction: 'input',
      consumer: null,
      activeLow: false,
      used: false,
    });

    const pulled = info.lines[1]!;
    expect(pulled).toMatchObject({ name: 'ID_SDA', direction: 'input', bias: 'pull-up' });

    const activeLow = info.lines[2]!;
    expect(activeLow).toMatchObject({
      offset: 2,
      name: 'PWR_LED_OFF',
      direction: 'output',
      activeLow: true,
      consumer: 'led1',
      used: true,
    });

    const legacy = info.lines[3]!;
    expect(legacy).toMatchObject({
      offset: 17,
      name: 'GPIO17',
      consumer: 'led',
      direction: 'output',
      activeLow: false,
      used: true,
    });
  });

  it('collects non-line gpioinfo chatter instead of guessing', () => {
    const info = parseGpioinfoOutput('some future banner\nline 0: "X" input');
    expect(info.unparsed).toEqual(['some future banner']);
    expect(info.lines).toHaveLength(1);
  });

  it('parses numeric gpioget output in printed order', () => {
    expect(parseGpiogetValues('1 0\n')).toEqual([1, 0]);
    expect(parseGpiogetValues('17=1 18=0')).toEqual([1, 0]);
    expect(() => parseGpiogetValues('')).toThrowError(LibgpiodError);
    expect(() => parseGpiogetValues('1 2')).toThrowError(LibgpiodError);
  });

  it('parses the requested gpiomon format and the v2 default format', () => {
    expect(parseGpiomonLine('17 1 10002.907638045')).toMatchObject({
      offset: 17,
      name: null,
      edge: 'rising',
      deviceTimestampSeconds: 10002.907638045,
    });
    expect(parseGpiomonLine('17 2 1.5')).toMatchObject({ offset: 17, edge: 'falling' });
    expect(parseGpiomonLine('10002.907638045\trising\t"GPIO22"')).toMatchObject({
      offset: null,
      name: 'GPIO22',
      edge: 'rising',
    });
    expect(parseGpiomonLine('17 3 1.5')).toBeNull();
    expect(parseGpiomonLine('not an event')).toBeNull();
  });

  it('canonicalizes chip spellings', () => {
    expect(normalizeChipName('0')).toBe('gpiochip0');
    expect(normalizeChipName(' 3 ')).toBe('gpiochip3');
    expect(normalizeChipName('gpiochip2')).toBe('gpiochip2');
    expect(normalizeChipName('/dev/gpiochip1')).toBe('gpiochip1');
  });
});

describe('GpioTools command construction', () => {
  it('runs gpiodetect with a pinned locale', async () => {
    const runner = new FakeCommandRunner().enqueue({ stdout: 'gpiochip0 [x] (2 lines)\n' });
    const tools = makeTools(runner);
    const chips = await tools.detectChips();
    expect(chips).toHaveLength(1);
    expect(runner.usedTools()).toEqual(['gpiodetect']);
    expect(runner.runs[0]!.args).toEqual([]);
    expect(runner.runs[0]!.options.env).toEqual({ LC_ALL: 'C', LANG: 'C' });
    expect(runner.runs[0]!.options.timeoutMs).toBe(5000);
  });

  it('runs gpioinfo against the requested chip', async () => {
    const runner = new FakeCommandRunner().enqueue({
      stdout: 'gpiochip1 - 8 lines:\n\tline 0: unnamed input\n',
    });
    const tools = makeTools(runner);
    const info = await tools.infoChip('gpiochip1');
    expect(info.lines).toHaveLength(1);
    expect(runner.runs[0]!.args).toEqual(['--chip', 'gpiochip1']);
  });

  it('reads lines with --as-is and no invented flags', async () => {
    const runner = new FakeCommandRunner().enqueue({ stdout: '1 0\n' });
    const tools = makeTools(runner);
    const values = await tools.getLines('gpiochip0', [17, 18]);
    expect(values).toEqual([1, 0]);
    expect(runner.runs[0]!.args).toEqual([
      '--chip',
      'gpiochip0',
      '--consumer',
      'pinout',
      '--numeric',
      '--as-is',
      '17',
      '18',
    ]);
  });

  it('passes --bias only for explicit bias settings', async () => {
    const runner = new FakeCommandRunner().enqueue({ stdout: '0\n' });
    const tools = makeTools(runner);
    await tools.getLines('gpiochip0', [5], { bias: 'pull-up' });
    expect(runner.runs[0]!.args).toContain('--bias');
    expect(runner.runs[0]!.args).toContain('pull-up');

    runner.enqueue({ stdout: '0\n' });
    await tools.getLines('gpiochip0', [5], { bias: 'as-is' });
    expect(runner.runs[1]!.args).not.toContain('--bias');
  });

  it('refuses a partial gpioget mapping', async () => {
    const runner = new FakeCommandRunner().enqueue({ stdout: '1 0 1\n' });
    const tools = makeTools(runner);
    await expect(tools.getLines('gpiochip0', [17, 18])).rejects.toMatchObject({
      code: 'GPIO_OPERATION_FAILED',
    });
  });

  it('validates offsets before invoking any tool', async () => {
    const runner = new FakeCommandRunner();
    const tools = makeTools(runner);
    await expect(tools.getLines('gpiochip0', [])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(tools.getLines('gpiochip0', [-1])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(tools.setLinesOnce('gpiochip0', [])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(
      tools.setLinesOnce('gpiochip0', [
        { offset: 1, raw: 1 },
        { offset: 1, raw: 0 },
      ]),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(runner.usedTools()).toEqual([]);
  });

  it('sets a line once with the documented hold-period/-t0 pattern', async () => {
    const runner = new FakeCommandRunner().enqueue({ stdout: '' });
    const tools = makeTools(runner);
    await tools.setLinesOnce('gpiochip0', [{ offset: 17, raw: 1 }]);
    expect(runner.runs[0]!.args).toEqual([
      '--chip',
      'gpiochip0',
      '--consumer',
      'pinout',
      '--hold-period',
      '20ms',
      '-t0',
      '17=1',
    ]);

    runner.enqueue({ stdout: '' });
    await tools.setLinesOnce('gpiochip0', [{ offset: 17, raw: 0 }], { holdPeriodMs: 0 });
    expect(runner.runs[1]!.args).toContain('0ms');
  });

  it('refuses a negative hold period', async () => {
    const runner = new FakeCommandRunner();
    const tools = makeTools(runner);
    await expect(
      tools.setLinesOnce('gpiochip0', [{ offset: 17, raw: 1 }], { holdPeriodMs: -5 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(runner.usedTools()).toEqual([]);
  });
});

describe('GpioTools failure mapping', () => {
  it('maps a timed-out run to COMMAND_TIMEOUT', async () => {
    const runner = new FakeCommandRunner().enqueueTimeout();
    const tools = makeTools(runner);
    await expect(tools.detectChips()).rejects.toMatchObject({ code: 'COMMAND_TIMEOUT' });
  });

  it('maps ENOENT on run to GPIO_TOOL_MISSING', async () => {
    const runner = new FakeCommandRunner().enqueueMissingTool('gpioget');
    const tools = makeTools(runner);
    try {
      await tools.getLines('gpiochip0', [17]);
      expect.unreachable('Should have thrown');
    } catch (error) {
      const libgpiodError = error as LibgpiodError;
      expect(libgpiodError.code).toBe('GPIO_TOOL_MISSING');
      expect(libgpiodError.details).toMatchObject({ tool: 'gpioget', spawnErrorCode: 'ENOENT' });
    }
  });

  it('classifies missing lines from tool stderr but keeps the raw text', async () => {
    const runner = new FakeCommandRunner().enqueueError(1, 'gpioget: cannot find line 99 in gpiochip0\n');
    const tools = makeTools(runner);
    try {
      await tools.getLines('gpiochip0', [99]);
      expect.unreachable('Should have thrown');
    } catch (error) {
      const libgpiodError = error as LibgpiodError;
      expect(libgpiodError.code).toBe('GPIO_LINE_NOT_FOUND');
      expect(libgpiodError.details).toMatchObject({
        phase: 'tool',
        exitCode: 1,
        stderr: expect.stringContaining('cannot find line 99'),
      });
    }
  });

  it('classifies a missing chip from tool stderr', async () => {
    const runner = new FakeCommandRunner().enqueueError(1, 'gpioinfo: unable to find GPIO chip 7\n');
    const tools = makeTools(runner);
    await expect(tools.infoChip('gpiochip7')).rejects.toMatchObject({
      code: 'GPIOCHIP_NOT_FOUND',
    });
  });

  it('refuses to run any tool on non-Linux platforms', async () => {
    const runner = new FakeCommandRunner();
    const tools = new GpioTools({ runner, platform: 'darwin' });
    await expect(tools.detectChips()).rejects.toMatchObject({ code: 'PLATFORM_UNSUPPORTED' });
    await expect(tools.infoChip('gpiochip0')).rejects.toMatchObject({
      code: 'PLATFORM_UNSUPPORTED',
    });
    await expect(tools.getLines('gpiochip0', [0])).rejects.toMatchObject({
      code: 'PLATFORM_UNSUPPORTED',
    });
    expect(runner.usedTools()).toEqual([]);
  });
});

describe('GpioTools holder and watch processes', () => {
  it('spawns a holding gpioset child and terminates it on demand', async () => {
    const runner = new FakeCommandRunner();
    const tools = makeTools(runner);
    const held = await tools.holdLines('gpiochip0', [{ offset: 17, raw: 1 }]);
    expect(held.pid).toBeTypeOf('number');
    expect(held.values).toEqual([{ offset: 17, raw: 1 }]);
    expect(runner.spawns[0]!.file).toBe('gpioset');
    expect(runner.spawns[0]!.args).toEqual([
      '--chip',
      'gpiochip0',
      '--consumer',
      'pinout',
      '17=1',
    ]);
    expect(runner.spawns[0]!.args).not.toContain('-t0');

    const info = await held.terminate();
    expect(info).toMatchObject({ code: null, signal: 'SIGTERM' });
    expect(runner.spawns[0]!.process.signals).toEqual(['SIGTERM']);
  });

  it('rejects a holder that dies during the startup grace window', async () => {
    const runner = new FakeCommandRunner();
    runner.onSpawn = (process) => {
      process.pushStderr('gpioset: cannot find line 17\n');
      process.exit({ code: 1, signal: null });
    };
    const tools = makeTools(runner);
    try {
      await tools.holdLines('gpiochip0', [{ offset: 17, raw: 1 }]);
      expect.unreachable('Should have thrown');
    } catch (error) {
      const libgpiodError = error as LibgpiodError;
      expect(libgpiodError.code).toBe('GPIO_LINE_NOT_FOUND');
      expect(libgpiodError.details).toMatchObject({
        stderr: expect.stringContaining('cannot find line 17'),
      });
    }
  });

  it('maps spawn ENOENT on a holder to GPIO_TOOL_MISSING', async () => {
    const runner = new FakeCommandRunner();
    runner.onSpawn = (process) => {
      process.exit({
        code: null,
        signal: null,
        error: { code: 'ENOENT', message: 'spawn gpioset ENOENT' },
      });
    };
    const tools = makeTools(runner);
    await expect(tools.holdLines('gpiochip0', [{ offset: 17, raw: 1 }])).rejects.toMatchObject({
      code: 'GPIO_TOOL_MISSING',
    });
  });

  it('turns gpiomon output into edge events with receipt timestamps', async () => {
    const runner = new FakeCommandRunner();
    const tools = makeTools(runner);
    const events: GpioWatchEvent[] = [];
    const watch = await tools.watchLines('gpiochip0', [17], {
      debounceMs: 0,
      onEvent: (event) => events.push(event),
    });
    expect(runner.spawns[0]!.file).toBe('gpiomon');
    expect(runner.spawns[0]!.args).toEqual([
      '--chip',
      'gpiochip0',
      '--consumer',
      'pinout',
      '--format=%o %e %S',
      '--edges',
      'both',
      '17',
    ]);

    runner.spawns[0]!.process.pushStdout('17 1 10002.907638045\n17 2 10002.910000000\n');
    await flush();

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      offset: 17,
      raw: 1,
      edge: 'rising',
      deviceTimestampSeconds: 10002.907638045,
    });
    expect(events[0]!.receivedAt).toBeInstanceOf(Date);
    expect(events[1]).toMatchObject({ offset: 17, raw: 0, edge: 'falling' });
    expect(watch.stats.events).toBe(2);

    await watch.stop();
    expect(runner.spawns[0]!.process.signals).toEqual(['SIGTERM']);
  });

  it('debounces per line and counts what it drops', async () => {
    const runner = new FakeCommandRunner();
    const tools = makeTools(runner);
    const events: GpioWatchEvent[] = [];
    const watch = await tools.watchLines('gpiochip0', [17], {
      debounceMs: 100,
      onEvent: (event) => events.push(event),
    });

    runner.spawns[0]!.process.pushStdout('17 1 1.0\n17 2 1.1\n17 1 1.2\n');
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0]!.edge).toBe('rising');
    expect(watch.stats).toMatchObject({ events: 1, debounced: 2 });
    await watch.stop();
  });

  it('counts unrecognized output instead of inventing events', async () => {
    const runner = new FakeCommandRunner();
    const tools = makeTools(runner);
    const events: GpioWatchEvent[] = [];
    const watch = await tools.watchLines('gpiochip0', [17], {
      debounceMs: 0,
      onEvent: (event) => events.push(event),
    });

    runner.spawns[0]!.process.pushStdout('10002.9\trising\t"GPIO22"\nnot an event\n17 1 1.5\n');
    await flush();

    expect(events).toHaveLength(1);
    expect(watch.stats).toMatchObject({ events: 1, unrecognizedLines: 2 });
    await watch.stop();
  });

  it('escalates to SIGKILL when a process ignores SIGTERM', async () => {
    const runner = new FakeCommandRunner();
    const tools = makeTools(runner);
    const held = await tools.holdLines('gpiochip0', [{ offset: 17, raw: 1 }]);
    const process = runner.spawns[0]!.process;
    process.autoExitOnKill = false;

    const exitPromise = held.terminate(10);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(process.signals).toEqual(['SIGTERM', 'SIGKILL']);
    process.exit({ code: null, signal: 'SIGKILL' });
    await expect(exitPromise).resolves.toMatchObject({ signal: 'SIGKILL' });
  });
});
