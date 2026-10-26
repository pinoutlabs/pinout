import type { DaemonClient } from './daemonClient.js';
import type { PendingStore } from './pendingStore.js';

/**
 * Safety aborts stay inside Pinout: cancel in-flight ops, release leases owned
 * by the RAP thread (group_id), and disarm / safeState devices the thread touched.
 */
export async function abortThreadSafety(
  daemon: DaemonClient,
  store: PendingStore,
  groupId: string,
  reason: string,
): Promise<{ cancelledOps: string[]; releasedLeases: string[]; disarmedDevices: string[] }> {
  const thread = store.getThread(groupId);
  const cancelledOps: string[] = [];
  const releasedLeases: string[] = [];
  const disarmedDevices: string[] = [];

  const openCalls = store
    .listCalls()
    .filter((call) => call.groupId === groupId && call.daemonOperationId);
  for (const call of openCalls) {
    if (!call.daemonOperationId) continue;
    try {
      await daemon.cancelOperation(call.daemonOperationId, reason);
      cancelledOps.push(call.daemonOperationId);
    } catch {
      // best effort
    }
    call.cancelled = true;
    if (call.status === 'accepted' || call.status === 'running' || call.status === 'delivering') {
      call.status = 'cancelled';
      call.updatedAt = Date.now();
      store.upsertCall(call);
    }
  }

  const leaseIds = thread?.leaseIds ?? [];
  for (const leaseId of leaseIds) {
    try {
      await daemon.releaseLease(leaseId, groupId);
      releasedLeases.push(leaseId);
      store.removeLease(groupId, leaseId);
    } catch {
      // best effort — lease may already be gone
    }
  }

  // Also release any leases currently listed for this owner on the daemon.
  try {
    const listed = await daemon.listLeases();
    const leases = Array.isArray(listed.leases) ? listed.leases : [];
    for (const raw of leases) {
      const lease = raw as { id?: string; owner?: string };
      if (typeof lease.id !== 'string' || lease.owner !== groupId) continue;
      if (releasedLeases.includes(lease.id)) continue;
      try {
        await daemon.releaseLease(lease.id, groupId);
        releasedLeases.push(lease.id);
        store.removeLease(groupId, lease.id);
      } catch {
        // ignore
      }
    }
  } catch {
    // daemon unreachable — journaled lease ids already attempted above
  }

  const deviceIds = thread?.deviceIds ?? [];
  for (const deviceId of deviceIds) {
    try {
      await daemon.disarmOrSafeState(deviceId, groupId);
      disarmedDevices.push(deviceId);
    } catch {
      // best effort
    }
  }

  return { cancelledOps, releasedLeases, disarmedDevices };
}
