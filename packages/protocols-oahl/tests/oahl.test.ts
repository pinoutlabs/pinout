import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLabWorkbench, defaultLabDeviceIds } from '@pinout/core';
import { OahlBridge, OahlClient, OahlError, OahlHttpServer } from '../src/index.js';

describe('OAHL (Open Agent Hardware Layer) Protocol Link', () => {
  let bridge: OahlBridge;
  let server: OahlHttpServer;
  let client: OahlClient;
  let serverUrl: string;

  beforeAll(async () => {
    const runtime = await createLabWorkbench({
      includeSyringePump: true,
      includeCentrifuge: true,
      includeHeaterShaker: true,
      includePipette: true,
    });

    bridge = new OahlBridge(runtime, { defaultTtlMs: 15_000, maxTtlMs: 60_000 });
    server = new OahlHttpServer(bridge, { port: 0, host: '127.0.0.1' });
    const { port, host } = await server.listen(0, '127.0.0.1');
    serverUrl = `http://${host}:${port}`;
    client = new OahlClient({ baseUrl: serverUrl });
  });

  afterAll(async () => {
    await server.close();
  });

  describe('Direct Bridge Integration', () => {
    it('executes 4-phase contract: discover -> reserve -> execute -> release', async () => {
      // 1. Discover
      const discovery = await bridge.discover();
      expect(discovery.protocolVersion).toBe('1.0.0');
      expect(discovery.devices.length).toBe(4);

      const syringe = discovery.devices.find((d) => d.id === defaultLabDeviceIds.syringePump);
      expect(syringe).toBeDefined();
      expect(syringe?.available).toBe(true);

      // 2. Reserve
      const reservation = await bridge.reserve({
        deviceId: defaultLabDeviceIds.syringePump,
        owner: 'agent-alice',
        ttlMs: 5000,
      });
      expect(reservation.status).toBe('acquired');
      expect(reservation.owner).toBe('agent-alice');
      expect(reservation.reservationId).toBeTruthy();

      // Discover reflects reservation
      const discoveryAfterReserve = await bridge.discover();
      const reservedSyringe = discoveryAfterReserve.devices.find(
        (d) => d.id === defaultLabDeviceIds.syringePump,
      );
      expect(reservedSyringe?.available).toBe(false);
      expect(reservedSyringe?.currentReservation?.owner).toBe('agent-alice');

      // Conflict rejection when another agent tries to acquire
      await expect(
        bridge.reserve({
          deviceId: defaultLabDeviceIds.syringePump,
          owner: 'agent-bob',
        }),
      ).rejects.toThrow(/currently reserved/);

      // 3. Execute
      const execResult = await bridge.execute({
        reservationId: reservation.reservationId,
        deviceId: defaultLabDeviceIds.syringePump,
        action: 'syringe_pump.infuse',
        params: { volumeMl: 2.5 },
      });
      expect(execResult.status).toBe('completed');
      expect(execResult.result).toEqual({
        infusedMl: 2.5,
        remainingVolumeMl: 37.5,
      });

      // Renew reservation
      const renewResult = await bridge.renew({
        reservationId: reservation.reservationId,
        ttlMs: 8000,
      });
      expect(renewResult.grantedTtlMs).toBe(8000);

      // 4. Release
      const releaseResult = await bridge.release({
        reservationId: reservation.reservationId,
      });
      expect(releaseResult.released).toBe(true);

      // Syringe pump is now available again
      const discoveryAfterRelease = await bridge.discover();
      const releasedSyringe = discoveryAfterRelease.devices.find(
        (d) => d.id === defaultLabDeviceIds.syringePump,
      );
      expect(releasedSyringe?.available).toBe(true);
      expect(releasedSyringe?.currentReservation).toBeUndefined();
    });
  });

  describe('HTTP Server & Client SDK', () => {
    it('serves OAHL protocol over REST to client SDK', async () => {
      // 1. Discover via client SDK
      const discovery = await client.discover({ deviceClass: 'lab.centrifuge' });
      expect(discovery.devices.length).toBe(1);
      const centrifuge = discovery.devices[0]!;
      expect(centrifuge.id).toBe(defaultLabDeviceIds.centrifuge);
      expect(centrifuge.available).toBe(true);

      // 2. Reserve via client SDK
      const reservation = await client.reserve({
        deviceId: defaultLabDeviceIds.centrifuge,
        owner: 'agent-carol',
        ttlMs: 10_000,
      });
      expect(reservation.status).toBe('acquired');
      expect(reservation.owner).toBe('agent-carol');

      // 3. Execute via client SDK (set speed & start)
      const setSpeedRes = await client.execute({
        reservationId: reservation.reservationId,
        deviceId: defaultLabDeviceIds.centrifuge,
        action: 'centrifuge.set_speed',
        params: { rpm: 6000 },
      });
      expect(setSpeedRes.status).toBe('completed');
      expect(setSpeedRes.result?.targetRpm).toBe(6000);

      // Start centrifuge
      const startRes = await client.execute({
        reservationId: reservation.reservationId,
        deviceId: defaultLabDeviceIds.centrifuge,
        action: 'centrifuge.start',
      });
      expect(startRes.status).toBe('completed');
      expect(startRes.result?.running).toBe(true);

      // 4. Release with safe-park via client SDK
      const releaseRes = await client.release({
        reservationId: reservation.reservationId,
        deviceId: defaultLabDeviceIds.centrifuge,
        safePark: true,
      });
      expect(releaseRes.released).toBe(true);

      // Check device is stopped after release safePark
      const statusRes = await bridge.runtime.invoke(
        defaultLabDeviceIds.centrifuge,
        'centrifuge.read',
        {},
      );
      expect(statusRes.running).toBe(false);
    });

    it('rejects execution with expired or invalid reservationId', async () => {
      try {
        await client.execute({
          reservationId: 'invalid-reservation-id',
          deviceId: defaultLabDeviceIds.pipette,
          action: 'pipette.read',
        });
        expect.fail('Should have thrown OahlError');
      } catch (err) {
        expect(err).toBeInstanceOf(OahlError);
        const oahlErr = err as OahlError;
        expect(oahlErr.code).toBe('RESERVATION_EXPIRED');
        expect(oahlErr.statusCode).toBe(410);
      }
    });
  });
});
