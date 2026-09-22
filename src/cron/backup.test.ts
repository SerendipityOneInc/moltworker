import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Sandbox } from '@cloudflare/sandbox';
import { BACKUP_STATE_KEY, getSnapshotIntervalMs, isDue, runScheduledBackup } from './backup';
import {
  createMockBucket,
  createMockEnv,
  createMockExecResult,
  seedJson,
  suppressConsole,
} from '../test-utils';

const MINUTE = 60_000;
const NOW = Date.parse('2026-09-22T12:00:00.000Z');

function createBackupSandbox(safe: boolean, containerStatus: string = 'healthy') {
  const execMock = vi.fn(async () => createMockExecResult('', { exitCode: safe ? 0 : 1 }));
  const createBackupMock = vi.fn().mockResolvedValue({ id: 'snap-new', dir: '/home/openclaw' });
  const getStateMock = vi.fn().mockResolvedValue({ status: containerStatus, lastChange: 0 });
  const sandbox = {
    exec: execMock,
    createBackup: createBackupMock,
    getState: getStateMock,
  } as unknown as Sandbox;
  return { sandbox, execMock, createBackupMock };
}

function seedSnapshot(objects: ReturnType<typeof createMockBucket>['objects'], ageMs: number) {
  seedJson(objects, 'backup-handles.json', {
    snapshots: [
      { id: 'snap-old', dir: '/home/openclaw', createdAt: new Date(NOW - ageMs).toISOString() },
    ],
  });
}

describe('getSnapshotIntervalMs', () => {
  it('defaults to 15 minutes', () => {
    expect(getSnapshotIntervalMs(createMockEnv())).toBe(15 * MINUTE);
  });

  it('parses overrides and allows 0 to disable', () => {
    expect(getSnapshotIntervalMs(createMockEnv({ BACKUP_INTERVAL_MINUTES: '5' }))).toBe(5 * MINUTE);
    expect(getSnapshotIntervalMs(createMockEnv({ BACKUP_INTERVAL_MINUTES: '0' }))).toBe(0);
  });

  it('falls back to the default for invalid values', () => {
    expect(getSnapshotIntervalMs(createMockEnv({ BACKUP_INTERVAL_MINUTES: 'abc' }))).toBe(
      15 * MINUTE,
    );
    expect(getSnapshotIntervalMs(createMockEnv({ BACKUP_INTERVAL_MINUTES: '-1' }))).toBe(
      15 * MINUTE,
    );
  });
});

describe('isDue', () => {
  it('is due when there is no previous backup', () => {
    expect(isDue(null, MINUTE, NOW)).toBe(true);
  });

  it('is due only once the interval has elapsed', () => {
    expect(isDue(NOW - MINUTE + 1, MINUTE, NOW)).toBe(false);
    expect(isDue(NOW - MINUTE, MINUTE, NOW)).toBe(true);
  });

  it('is never due when disabled', () => {
    expect(isDue(null, 0, NOW)).toBe(false);
  });
});

describe('runScheduledBackup', () => {
  beforeEach(() => {
    suppressConsole();
  });

  it('is disabled when the container is allowed to sleep', async () => {
    const { bucket } = createMockBucket(() => new Date(NOW));
    const { sandbox, execMock } = createBackupSandbox(true);
    const env = createMockEnv({ BACKUP_BUCKET: bucket, SANDBOX_SLEEP_AFTER: '10m' });

    expect(await runScheduledBackup(env, sandbox, NOW)).toEqual({ status: 'disabled' });
    expect(execMock).not.toHaveBeenCalled();
  });

  it('does not touch the container when a recent snapshot exists', async () => {
    const { bucket, objects } = createMockBucket(() => new Date(NOW));
    seedSnapshot(objects, 5 * MINUTE);
    const { sandbox, execMock } = createBackupSandbox(true);
    const env = createMockEnv({ BACKUP_BUCKET: bucket });

    expect(await runScheduledBackup(env, sandbox, NOW)).toEqual({ status: 'not_due' });
    expect(execMock).not.toHaveBeenCalled();
  });

  it('does not start a stopped container', async () => {
    const { bucket, objects } = createMockBucket(() => new Date(NOW));
    const { sandbox, execMock } = createBackupSandbox(true, 'stopped');
    const env = createMockEnv({ BACKUP_BUCKET: bucket });

    expect(await runScheduledBackup(env, sandbox, NOW)).toEqual({ status: 'not_running' });
    expect(execMock).not.toHaveBeenCalled();
    expect(objects.has(BACKUP_STATE_KEY)).toBe(false);
  });

  it('creates a snapshot when due and releases the lock', async () => {
    const { bucket, objects } = createMockBucket(() => new Date(NOW));
    seedSnapshot(objects, 20 * MINUTE);
    const { sandbox, createBackupMock } = createBackupSandbox(true);
    const env = createMockEnv({ BACKUP_BUCKET: bucket });

    expect(await runScheduledBackup(env, sandbox, NOW)).toEqual({
      status: 'done',
      snapshotId: 'snap-new',
    });
    expect(createBackupMock).toHaveBeenCalledTimes(1);
    expect(objects.has('backup-lock')).toBe(false);
  });

  it('refuses to back up an unrestored container and waits an interval to retry', async () => {
    const { bucket, objects } = createMockBucket(() => new Date(NOW));
    const { sandbox, createBackupMock, execMock } = createBackupSandbox(false);
    const env = createMockEnv({ BACKUP_BUCKET: bucket });

    expect(await runScheduledBackup(env, sandbox, NOW)).toEqual({ status: 'unsafe' });
    expect(createBackupMock).not.toHaveBeenCalled();
    expect(objects.has(BACKUP_STATE_KEY)).toBe(true);

    execMock.mockClear();
    expect(await runScheduledBackup(env, sandbox, NOW + MINUTE)).toEqual({ status: 'not_due' });
    expect(execMock).not.toHaveBeenCalled();

    expect((await runScheduledBackup(env, sandbox, NOW + 15 * MINUTE)).status).toBe('unsafe');
  });

  it('records failures and backs off instead of retrying every minute', async () => {
    const { bucket, objects } = createMockBucket(() => new Date(NOW));
    seedSnapshot(objects, 20 * MINUTE);
    const { sandbox, createBackupMock } = createBackupSandbox(true);
    createBackupMock.mockRejectedValue(new Error('upload failed'));
    const env = createMockEnv({ BACKUP_BUCKET: bucket });

    expect(await runScheduledBackup(env, sandbox, NOW)).toEqual({
      status: 'failed',
      error: 'upload failed',
    });
    expect(await runScheduledBackup(env, sandbox, NOW + MINUTE)).toEqual({ status: 'not_due' });
  });

  it('skips while another backup holds the lock', async () => {
    const { bucket, objects } = createMockBucket(() => new Date(NOW));
    seedJson(objects, 'backup-lock', { expiresAt: NOW + MINUTE });
    const { sandbox, execMock } = createBackupSandbox(true);
    const env = createMockEnv({ BACKUP_BUCKET: bucket });

    expect(await runScheduledBackup(env, sandbox, NOW)).toEqual({ status: 'locked' });
    expect(execMock).not.toHaveBeenCalled();
  });

  it('takes over an expired lock', async () => {
    const { bucket, objects } = createMockBucket(() => new Date(NOW));
    seedJson(objects, 'backup-lock', { expiresAt: NOW - 1 });
    const { sandbox } = createBackupSandbox(true);
    const env = createMockEnv({ BACKUP_BUCKET: bucket });

    expect((await runScheduledBackup(env, sandbox, NOW)).status).toBe('done');
  });
});
