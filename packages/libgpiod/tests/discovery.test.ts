import { describe, expect, it } from 'vitest';
import { proposeLibgpiodDevices } from '../src/discovery.js';
import { FakeCommandRunner } from './fakeRunner.js';

const detectOutput = 'gpiochip0 [pinctrl-rp1] (54 lines)\ngpiochip1 [rp1-gpio] (28 lines)\n';

const gpiochip0Info = [
  'gpiochip0 - 54 lines:',
  '\tline   0: unnamed input',
  '\tline   1: "ID_SDA" input bias=pull-up',
  '\tline   2: "STATUS_LED" output active-low consumer="led1"',
  '\tline  17: "GPIO17" output',
  '\tline  22: "GPIO22" input',
].join('\n');

const gpiochip1Info = [
  'gpiochip1 - 28 lines:',
  '\tline   0: unnamed input',
  '\tline   1: "FAN"\t"pwm"\toutput\t[used]',
  '\tline   7: "BTN_A" input',
].join('\n');

describe('proposeLibgpiodDevices', () => {
  it('proposes one read-only device per chip with an input-only configuration', async () => {
    const runner = new FakeCommandRunner()
      .enqueue({ stdout: detectOutput })
      .enqueue({ stdout: gpiochip0Info })
      .enqueue({ stdout: gpiochip1Info });

    const devices = await proposeLibgpiodDevices(runner, { platform: 'linux' });

    expect(devices).toHaveLength(2);
    const [chip0, chip1] = devices;
    expect(chip0).toMatchObject({
      id: 'linux-gpio-gpiochip0',
      moduleId: 'pinout/linux-gpio',
      deviceClass: 'controller.linux-sbc-gpio',
      chip: 'gpiochip0',
      chipLabel: 'pinctrl-rp1',
      lineCount: 54,
      readOnly: true,
    });
    expect(chip1).toMatchObject({ id: 'linux-gpio-gpiochip1', chip: 'gpiochip1' });

    const suggested = chip0!.suggestedConfig;
    expect(suggested.chip).toBe('gpiochip0');
    expect(suggested.lines.map((line) => line.offset)).toEqual([0, 1, 22]);
    expect(suggested.lines[0]).toEqual({
      offset: 0,
      name: 'line0',
      direction: 'input',
      polarity: 'active-high',
      safeLevel: 'high-z',
      bias: 'as-is',
    });
    expect(suggested.lines[1]).toEqual({
      offset: 1,
      name: 'ID_SDA',
      direction: 'input',
      polarity: 'active-high',
      safeLevel: 'high-z',
      bias: 'pull-up',
    });

    // The full line list still reports claimed lines for visibility.
    const claimed = chip0!.lines.find((line) => line.offset === 2);
    expect(claimed).toMatchObject({
      name: 'STATUS_LED',
      direction: 'output',
      consumer: 'led1',
      activeLow: true,
      used: true,
    });
    expect(chip0!.notes.join(' ')).toMatch(/2 line\(s\).*excluded/);
  });

  it('never invokes an actuating tool', async () => {
    const runner = new FakeCommandRunner()
      .enqueue({ stdout: detectOutput })
      .enqueue({ stdout: gpiochip0Info })
      .enqueue({ stdout: gpiochip1Info });

    await proposeLibgpiodDevices(runner, { platform: 'linux' });

    const used = runner.usedTools();
    expect(used).toEqual(['gpiodetect', 'gpioinfo', 'gpioinfo']);
    expect(used).not.toContain('gpioset');
    expect(used).not.toContain('gpioget');
    expect(used).not.toContain('gpiomon');
    expect(runner.spawns).toEqual([]);
  });

  it('can restrict discovery to a single chip', async () => {
    const runner = new FakeCommandRunner()
      .enqueue({ stdout: detectOutput })
      .enqueue({ stdout: gpiochip1Info });

    const devices = await proposeLibgpiodDevices(runner, { platform: 'linux', chip: '1' });

    expect(devices).toHaveLength(1);
    expect(devices[0]!.chip).toBe('gpiochip1');
    expect(runner.runs[1]!.args).toEqual(['--chip', 'gpiochip1']);
  });

  it('fails loudly when the requested chip does not exist', async () => {
    const runner = new FakeCommandRunner().enqueue({ stdout: detectOutput });
    await expect(
      proposeLibgpiodDevices(runner, { platform: 'linux', chip: 'gpiochip9' }),
    ).rejects.toMatchObject({
      code: 'GPIOCHIP_NOT_FOUND',
      details: expect.objectContaining({ availableChips: ['gpiochip0', 'gpiochip1'] }),
    });
    expect(runner.usedTools()).toEqual(['gpiodetect']);
  });

  it('refuses to run on non-Linux platforms', async () => {
    const runner = new FakeCommandRunner();
    await expect(proposeLibgpiodDevices(runner, { platform: 'darwin' })).rejects.toMatchObject({
      code: 'PLATFORM_UNSUPPORTED',
    });
    expect(runner.usedTools()).toEqual([]);
  });

  it('sanitizes names, deduplicates them, and notes unparsed lines', async () => {
    const runner = new FakeCommandRunner()
      .enqueue({ stdout: 'gpiochip0 [x] (8 lines)\n' })
      .enqueue({
        stdout: [
          'gpiochip0 - 8 lines:',
          '\tline 4: "SIG/O%NAME" input',
          '\tline 5: "DUP" input',
          '\tline 6: "DUP" input',
          'mystery line that is not a line entry',
        ].join('\n'),
      });

    const devices = await proposeLibgpiodDevices(runner, { platform: 'linux' });
    const [device] = devices;
    expect(device!.suggestedConfig.lines.map((line) => line.name)).toEqual([
      'SIG_O_NAME',
      'DUP',
      'DUP_6',
    ]);
    expect(device!.notes.join(' ')).toMatch(/not recognized/);
  });
});
