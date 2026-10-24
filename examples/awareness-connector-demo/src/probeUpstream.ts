/**
 * Detect whether a running pinoutd already exposes awareness/connector routes
 * (PR1/PR4). When present, the demo prefers the real daemon; otherwise it
 * boots the local SIMULATED stub.
 */
export interface UpstreamProbeResult {
  available: boolean;
  awareness: boolean;
  connectors: boolean;
  reason: string;
}

export async function probeAwarenessUpstream(
  baseUrl: string,
  token?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UpstreamProbeResult> {
  try {
    const health = await fetchImpl(`${baseUrl}/v1/health`);
    if (!health.ok) {
      return {
        available: false,
        awareness: false,
        connectors: false,
        reason: `health HTTP ${health.status}`,
      };
    }
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const awareness = await fetchImpl(`${baseUrl}/v1/awareness`, { headers });
    if (awareness.status === 404) {
      return {
        available: false,
        awareness: false,
        connectors: false,
        reason: 'pinoutd running but /v1/awareness not implemented yet (awaiting PR1)',
      };
    }
    if (!awareness.ok) {
      return {
        available: false,
        awareness: false,
        connectors: false,
        reason: `/v1/awareness HTTP ${awareness.status}`,
      };
    }
    const connectors = await fetchImpl(`${baseUrl}/v1/connectors`, { headers });
    const connectorsOk = connectors.ok;
    return {
      available: true,
      awareness: true,
      connectors: connectorsOk,
      reason: connectorsOk
        ? 'real pinoutd awareness + connectors'
        : 'awareness present; connectors routes missing (awaiting PR4)',
    };
  } catch (error) {
    return {
      available: false,
      awareness: false,
      connectors: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
