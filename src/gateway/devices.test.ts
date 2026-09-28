import { describe, it, expect } from 'vitest';
import { isApprovalSuccess, parseDeviceList, resolvePendingRequestId } from './devices';

const LIST = {
  pending: [
    { requestId: 'req-new', deviceId: 'dev-1', platform: 'iOS' },
    { requestId: 'req-other', deviceId: 'dev-2' },
  ],
  paired: [{ deviceId: 'dev-3' }],
};

describe('parseDeviceList', () => {
  it('parses JSON surrounded by log lines', () => {
    const stdout = `connecting...\n${JSON.stringify(LIST)}\ndone\n`;
    expect(parseDeviceList(stdout)?.pending).toHaveLength(2);
  });

  it('returns null for output without JSON or with broken JSON', () => {
    expect(parseDeviceList('no json here')).toBeNull();
    expect(parseDeviceList('{ not json }')).toBeNull();
  });

  it('defaults missing arrays', () => {
    expect(parseDeviceList('{"ok":true}')).toEqual({ pending: [], paired: [] });
  });
});

describe('resolvePendingRequestId', () => {
  it('keeps the requested id when it is still pending', () => {
    expect(resolvePendingRequestId(LIST, { requestId: 'req-new', deviceId: 'dev-1' })).toBe(
      'req-new',
    );
  });

  it('re-resolves a stale id through the device id', () => {
    expect(resolvePendingRequestId(LIST, { requestId: 'req-old', deviceId: 'dev-1' })).toBe(
      'req-new',
    );
  });

  it('returns null when the device has no pending request', () => {
    expect(
      resolvePendingRequestId(LIST, { requestId: 'req-old', deviceId: 'dev-gone' }),
    ).toBeNull();
    expect(resolvePendingRequestId(LIST, { requestId: 'req-old' })).toBeNull();
    expect(resolvePendingRequestId(null, { requestId: 'req-old', deviceId: 'dev-1' })).toBeNull();
  });
});

describe('isApprovalSuccess', () => {
  it('accepts the CLI success line or a zero exit code', () => {
    expect(isApprovalSuccess('Approved abc (req-1)', 1)).toBe(true);
    expect(isApprovalSuccess('', 0)).toBe(true);
  });

  it('rejects failures', () => {
    expect(isApprovalSuccess('No pending request matches req-1', 1)).toBe(false);
    expect(isApprovalSuccess('', undefined)).toBe(false);
  });
});
