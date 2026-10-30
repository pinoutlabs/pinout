import { afterEach, describe, expect, it } from 'vitest';
import {
  createUrRtdeClient,
  createUrSimulator,
  decodeBooleanReply,
  decodeDataPackage,
  decodeProtocolVersionReply,
  decodeRtdeFrame,
  decodeSetupOutputsReply,
  encodeProtocolVersionRequest,
  encodeSetupOutputsRequest,
  isRtdeValueType,
  RTDE_DEFAULT_OUTPUTS,
  RTDE_HEADER_SIZE,
  RTDE_VALUE_SIZES,
  RtdeCommand,
  tryDecodeRtdeFrame,
} from '../src/index.js';
import { expectErrorCode } from './errorAssertions.js';

describe('RTDE wire codec', () => {
  it('frames the protocol version request with a big-endian size header', () => {
    const frame = encodeProtocolVersionRequest(2);
    expect(Array.from(frame)).toEqual([0x00, 0x05, RtdeCommand.PROTOCOL_VERSION, 0x00, 0x02]);
    const decoded = decodeRtdeFrame(frame);
    expect(decoded.command).toBe(RtdeCommand.PROTOCOL_VERSION);
    expect(Array.from(decoded.payload)).toEqual([0x00, 0x02]);
  });

  it('decodes the 16-byte protocol version reply', () => {
    const payload = new Uint8Array(16);
    const view = new DataView(payload.buffer);
    view.setUint32(0, 2);
    view.setUint32(4, 1);
    view.setUint32(8, 2);
    view.setUint32(12, 3);
    expect(decodeProtocolVersionReply(payload)).toMatchObject({
      protocolVersion: 2,
      libraryVersionMajor: 1,
      libraryVersionMinor: 2,
      libraryVersionPatch: 3,
    });
    expectErrorCode(() => decodeProtocolVersionReply(new Uint8Array(12)), 'UR_RTDE_PROTOCOL_ERROR');
  });

  it('encodes the output recipe request and rejects invalid inputs', () => {
    const frame = encodeSetupOutputsRequest(125, ['timestamp', 'actual_q']);
    expect(frame[0]).toBe(0x00);
    expect(frame[1]).toBe(frame.length);
    expect(frame[2]).toBe(RtdeCommand.SETUP_OUTPUTS);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    expect(view.getFloat64(3, false)).toBe(125);
    expect(new TextDecoder().decode(frame.subarray(11))).toBe('timestamp,actual_q');

    expectErrorCode(() => encodeSetupOutputsRequest(0, ['timestamp']), 'UR_RTDE_INVALID_FREQUENCY');
    expectErrorCode(() => encodeSetupOutputsRequest(125, []), 'UR_RTDE_INVALID_OUTPUTS');
    expectErrorCode(() => encodeSetupOutputsRequest(125, ['bad,name']), 'UR_RTDE_INVALID_OUTPUTS');
  });

  it('decodes output recipe replies including NOT_FOUND entries', () => {
    const payload = new Uint8Array([
      0x07,
      ...new TextEncoder().encode('DOUBLE,VECTOR6D,NOT_FOUND'),
    ]);
    expect(decodeSetupOutputsReply(payload)).toEqual({
      recipeId: 7,
      types: ['DOUBLE', 'VECTOR6D', 'NOT_FOUND'],
    });
    expectErrorCode(
      () => decodeSetupOutputsReply(new Uint8Array([0x00, ...new TextEncoder().encode('BOGUS')])),
      'UR_RTDE_PROTOCOL_ERROR',
    );
  });

  it('extracts complete frames from buffered input and waits for partial ones', () => {
    const frame = encodeProtocolVersionRequest(2);
    expect(tryDecodeRtdeFrame(frame.subarray(0, RTDE_HEADER_SIZE - 1))).toBeUndefined();
    const partial = new Uint8Array(frame.length + 1);
    partial.set(frame);
    partial[frame.length] = 0x55;
    const decoded = tryDecodeRtdeFrame(partial);
    expect(decoded?.consumed).toBe(frame.length);
    expect(decoded?.frame.command).toBe(RtdeCommand.PROTOCOL_VERSION);
    expectErrorCode(
      () => decodeRtdeFrame(new Uint8Array([0x00, 0x09, 0x56])),
      'UR_RTDE_PROTOCOL_ERROR',
    );
    expectErrorCode(
      () => decodeRtdeFrame(new Uint8Array([0x00, 0x01, 0x56])),
      'UR_RTDE_PROTOCOL_ERROR',
    );
  });

  it('decodes typed, big-endian data packages', () => {
    const types = ['DOUBLE', 'VECTOR6D', 'INT32', 'BOOL'] as const;
    const size =
      1 + RTDE_VALUE_SIZES.DOUBLE + RTDE_VALUE_SIZES.VECTOR6D + RTDE_VALUE_SIZES.INT32 + 1;
    const payload = new Uint8Array(size);
    const view = new DataView(payload.buffer);
    payload[0] = 0x03;
    view.setFloat64(1, 12.5, false);
    for (let index = 0; index < 6; index += 1) {
      view.setFloat64(9 + index * 8, index / 2, false);
    }
    view.setInt32(57, -7, false);
    payload[61] = 1;
    expect(decodeDataPackage(payload, [...types])).toEqual({
      recipeId: 3,
      values: [12.5, [0, 0.5, 1, 1.5, 2, 2.5], -7, true],
    });
    expectErrorCode(
      () => decodeDataPackage(payload.subarray(0, 20), [...types]),
      'UR_RTDE_PROTOCOL_ERROR',
    );
  });

  it('exposes value types, sizes, defaults, and boolean replies', () => {
    expect(RTDE_DEFAULT_OUTPUTS).toEqual([
      'timestamp',
      'actual_q',
      'actual_TCP_pose',
      'robot_mode',
      'safety_mode',
    ]);
    expect(RTDE_VALUE_SIZES.VECTOR6D).toBe(48);
    expect(isRtdeValueType('VECTOR6D')).toBe(true);
    expect(isRtdeValueType('VECTOR9D')).toBe(false);
    expect(decodeBooleanReply(new Uint8Array([1]))).toBe(true);
    expect(decodeBooleanReply(new Uint8Array([0]))).toBe(false);
    expectErrorCode(() => decodeBooleanReply(new Uint8Array(0)), 'UR_RTDE_PROTOCOL_ERROR');
  });
});

describe('UrRtdeClient against the simulator', () => {
  const closers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      await closers
        .pop()!
        .close()
        .catch(() => undefined);
    }
  });

  it('performs the read-only handshake and reads samples', async () => {
    const sim = createUrSimulator();
    const rtde = createUrRtdeClient({
      transport: sim.rtde,
      timeoutMs: 2000,
      sampleTimeoutMs: 2000,
    });
    closers.push(rtde);
    await rtde.start();
    expect(rtde.negotiatedProtocolVersion).toBe(2);
    expect(rtde.outputRecipeId).toBe(0);

    const sample = await rtde.readSample(2000);
    expect(sample.recipeId).toBe(0);
    expect(Array.isArray(sample.values.actual_q)).toBe(true);
    expect((sample.values.actual_q as number[]).length).toBe(6);
    expect(typeof sample.controllerTimestamp).toBe('number');
    expect(sample.values.robot_mode).toBe(3); // POWER_OFF
    expect(sample.types.actual_TCP_pose).toBe('VECTOR6D');
    expect(sample.types.timestamp).toBe('DOUBLE');

    const second = await rtde.readSample(2000);
    expect(typeof second.at).toBe('number');
    expect(second.recipeId).toBe(0);
  });

  it('rejects unknown outputs with UR_RTDE_UNKNOWN_OUTPUTS', async () => {
    const sim = createUrSimulator();
    const rtde = createUrRtdeClient({
      transport: sim.rtde,
      outputs: ['timestamp', 'not_a_real_output'],
      timeoutMs: 2000,
    });
    closers.push(rtde);
    await expect(rtde.start()).rejects.toMatchObject({ code: 'UR_RTDE_UNKNOWN_OUTPUTS' });
    expect(rtde.negotiatedProtocolVersion).toBe(2); // negotiation succeeded before the recipe failed
  });

  it('rejects protocol versions below 2 with UR_RTDE_PROTOCOL_UNSUPPORTED', async () => {
    const sim = createUrSimulator({}, { protocolVersion: 1 });
    const rtde = createUrRtdeClient({ transport: sim.rtde, timeoutMs: 2000 });
    closers.push(rtde);
    await expect(rtde.start()).rejects.toMatchObject({ code: 'UR_RTDE_PROTOCOL_UNSUPPORTED' });
  });

  it('requires start() before pause()', async () => {
    const sim = createUrSimulator();
    const rtde = createUrRtdeClient({ transport: sim.rtde, timeoutMs: 2000 });
    closers.push(rtde);
    await expect(rtde.pause()).rejects.toMatchObject({ code: 'UR_RTDE_NOT_STARTED' });
  });

  it('pauses streaming and then times out with the connection left open', async () => {
    const sim = createUrSimulator();
    const rtde = createUrRtdeClient({ transport: sim.rtde, timeoutMs: 2000, sampleTimeoutMs: 100 });
    closers.push(rtde);
    await rtde.start();
    await rtde.readSample(2000); // prove streaming was live
    expect(await rtde.pause()).toBe(true);
    rtde.discardBufferedSamples();
    await expect(rtde.readSample(80)).rejects.toMatchObject({ code: 'UR_RTDE_TIMEOUT' });
    expect(rtde.connectionClosed).toBe(false);
  });

  it('times out when the simulator streams nothing', async () => {
    const sim = createUrSimulator({}, { streaming: false });
    const rtde = createUrRtdeClient({ transport: sim.rtde, timeoutMs: 2000, sampleTimeoutMs: 80 });
    closers.push(rtde);
    await rtde.start();
    await expect(rtde.readSample(80)).rejects.toMatchObject({ code: 'UR_RTDE_TIMEOUT' });
    expect(rtde.connectionClosed).toBe(false);
    // A manually emitted package still arrives deterministically.
    sim.rtde.emitSample();
    const sample = await rtde.readSample(500);
    expect(sample.recipeId).toBe(0);
  });

  it('reports UR_RTDE_CONNECTION_LOST when the transport closes', async () => {
    const sim = createUrSimulator();
    const rtde = createUrRtdeClient({ transport: sim.rtde, timeoutMs: 2000, sampleTimeoutMs: 200 });
    closers.push(rtde);
    await rtde.start();
    await sim.rtde.close();
    expect(rtde.connectionClosed).toBe(true);
    await expect(rtde.readSample(200)).rejects.toMatchObject({
      code: 'UR_RTDE_CONNECTION_LOST',
    });
    await expect(rtde.pause()).rejects.toMatchObject({ code: 'UR_RTDE_CONNECTION_LOST' });
  });

  it('rejects non-positive sample timeouts', async () => {
    const sim = createUrSimulator();
    const rtde = createUrRtdeClient({ transport: sim.rtde, timeoutMs: 2000 });
    closers.push(rtde);
    await rtde.start();
    rtde.discardBufferedSamples();
    expectErrorCode(() => {
      void rtde.readSample(0);
    }, 'UR_RTDE_INVALID_TIMEOUT');
  });

  it('tracks the latest sample and discards buffered samples', async () => {
    const sim = createUrSimulator({}, { streaming: false });
    const rtde = createUrRtdeClient({ transport: sim.rtde, timeoutMs: 2000, sampleTimeoutMs: 100 });
    closers.push(rtde);
    await rtde.start();
    expect(rtde.latest()).toBeUndefined();
    sim.rtde.emitSample();
    sim.rtde.emitSample();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rtde.latest()?.recipeId).toBe(0);
    expect(rtde.discardBufferedSamples()).toBe(2);
    expect(rtde.latest()).toBeUndefined();
  });
});
