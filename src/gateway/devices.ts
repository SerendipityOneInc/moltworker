/**
 * Helpers for the `openclaw devices` CLI output.
 *
 * A pending pairing request gets a new requestId every time the client
 * reconnects (the OpenClaw iOS app does this often), so the id shown in the
 * admin UI goes stale quickly and approving it fails. The deviceId is stable,
 * so approvals re-resolve the current request id from it.
 */

export interface PendingDevice {
  requestId: string;
  deviceId?: string;
  [key: string]: unknown;
}

export interface DeviceList {
  pending: PendingDevice[];
  paired: unknown[];
}

/** Parse the JSON object out of CLI output that may contain extra log lines */
export function parseDeviceList(stdout: string): DeviceList | null {
  const jsonMatch = stdout.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      pending: Array.isArray(parsed?.pending) ? parsed.pending : [],
      paired: Array.isArray(parsed?.paired) ? parsed.paired : [],
    };
  } catch {
    return null;
  }
}

/**
 * Find the pending request to approve: the requested id if it's still
 * pending, otherwise the current request for the same device.
 */
export function resolvePendingRequestId(
  list: DeviceList | null,
  requested: { requestId: string; deviceId?: string },
): string | null {
  const pending = list?.pending ?? [];
  if (pending.some((device) => device.requestId === requested.requestId)) {
    return requested.requestId;
  }
  if (!requested.deviceId) return null;
  const forDevice = pending.find((device) => device.deviceId === requested.deviceId);
  return forDevice?.requestId ?? null;
}

/** The CLI prints "Approved <deviceId> (<requestId>)" on success */
export function isApprovalSuccess(stdout: string, exitCode: number | undefined): boolean {
  return stdout.toLowerCase().includes('approved') || exitCode === 0;
}
