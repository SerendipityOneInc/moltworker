import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Sandbox } from '@cloudflare/sandbox';
import {
  clearPersistenceCache,
  createSnapshot,
  getSnapshotHandles,
  isSafeToBackup,
  isSnapshotGoneError,
  restoreIfNeeded,
  MAX_SNAPSHOTS,
  RESTORE_MARKER,
} from './persistence';
import { createMockBucket, createMockExecResult, seedJson, suppressConsole } from './test-utils';

function createBackupSandbox() {
  const execMock = vi.fn().mockResolvedValue(createMockExecResult());
  const restoreBackupMock = vi.fn().mockResolvedValue({ success: true });
  const createBackupMock = vi.fn();
  const readFileMock = vi.fn();
  const writeFileMock = vi.fn().mockResolvedValue({ success: true });
  const sandbox = {
    exec: execMock,
    restoreBackup: restoreBackupMock,
    createBackup: createBackupMock,
    readFile: readFileMock,
    writeFile: writeFileMock,
  } as unknown as Sandbox;
  return { sandbox, execMock, restoreBackupMock, createBackupMock, readFileMock, writeFileMock };
}

function handle(id: string, createdAt: string) {
  return { id, dir: '/home/openclaw', createdAt };
}

function expiredError() {
  return Object.assign(new Error('Backup x has expired'), { code: 'BACKUP_EXPIRED' });
}

function execCommands(execMock: ReturnType<typeof vi.fn>): string[] {
  return execMock.mock.calls.map((call) => call[0] as string);
}

describe('persistence', () => {
  beforeEach(() => {
    suppressConsole();
    clearPersistenceCache();
  });

  describe('restoreIfNeeded', () => {
    it('starts fresh and writes the marker when there are no backups', async () => {
      const { bucket } = createMockBucket();
      const { sandbox, execMock, restoreBackupMock } = createBackupSandbox();

      await restoreIfNeeded(sandbox, bucket);

      expect(restoreBackupMock).not.toHaveBeenCalled();
      expect(execCommands(execMock).some((cmd) => cmd.includes(RESTORE_MARKER))).toBe(true);
    });

    it('restores the newest snapshot', async () => {
      const { bucket, objects } = createMockBucket();
      seedJson(objects, 'backup-handles.json', {
        snapshots: [handle('new', '2026-09-02T00:00:00Z'), handle('old', '2026-09-01T00:00:00Z')],
      });
      const { sandbox, restoreBackupMock } = createBackupSandbox();

      await restoreIfNeeded(sandbox, bucket);

      expect(restoreBackupMock).toHaveBeenCalledTimes(1);
      expect(restoreBackupMock).toHaveBeenCalledWith({ id: 'new', dir: '/home/openclaw' });
    });

    it('skips restore on the fast path once restored', async () => {
      const { bucket } = createMockBucket();
      const { sandbox, execMock } = createBackupSandbox();

      await restoreIfNeeded(sandbox, bucket);
      execMock.mockClear();
      await restoreIfNeeded(sandbox, bucket);

      expect(execMock).not.toHaveBeenCalled();
    });

    it('falls back to an older snapshot when the newest has expired', async () => {
      const { bucket, objects } = createMockBucket();
      seedJson(objects, 'backup-handles.json', {
        snapshots: [handle('new', '2026-09-02T00:00:00Z'), handle('old', '2026-09-01T00:00:00Z')],
      });
      const { sandbox, restoreBackupMock } = createBackupSandbox();
      restoreBackupMock.mockRejectedValueOnce(expiredError());

      await restoreIfNeeded(sandbox, bucket);

      expect(restoreBackupMock).toHaveBeenLastCalledWith({ id: 'old', dir: '/home/openclaw' });
      expect((await getSnapshotHandles(bucket)).map((h) => h.id)).toEqual(['old']);
    });

    it('starts fresh but keeps expired snapshot objects when every snapshot has expired', async () => {
      const { bucket, objects } = createMockBucket();
      seedJson(objects, 'backup-handles.json', {
        snapshots: [handle('gone', '2026-09-01T00:00:00Z')],
      });
      seedJson(objects, 'backups/gone/meta.json', {});
      const { sandbox, execMock, restoreBackupMock } = createBackupSandbox();
      restoreBackupMock.mockRejectedValue(expiredError());

      await restoreIfNeeded(sandbox, bucket);

      expect(await getSnapshotHandles(bucket)).toEqual([]);
      expect(objects.has('backups/gone/meta.json')).toBe(true);
      expect(execCommands(execMock).some((cmd) => cmd.includes(RESTORE_MARKER))).toBe(true);
    });

    it('rethrows transient errors without trying older backups or writing the marker', async () => {
      const { bucket, objects } = createMockBucket();
      seedJson(objects, 'backup-handles.json', {
        snapshots: [handle('new', '2026-09-02T00:00:00Z'), handle('old', '2026-09-01T00:00:00Z')],
      });
      const { sandbox, execMock, restoreBackupMock } = createBackupSandbox();
      restoreBackupMock.mockRejectedValue(new Error('container unreachable'));

      await expect(restoreIfNeeded(sandbox, bucket)).rejects.toThrow('container unreachable');

      expect(restoreBackupMock).toHaveBeenCalledTimes(1);
      expect(execCommands(execMock).some((cmd) => cmd.includes(RESTORE_MARKER))).toBe(false);
    });

    it('restores from the legacy single-handle key', async () => {
      const { bucket, objects } = createMockBucket();
      seedJson(objects, 'backup-handle.json', { id: 'legacy', dir: '/home/openclaw' });
      const { sandbox, restoreBackupMock } = createBackupSandbox();

      await restoreIfNeeded(sandbox, bucket);

      expect(restoreBackupMock).toHaveBeenCalledWith({ id: 'legacy', dir: '/home/openclaw' });
    });
  });

  describe('createSnapshot', () => {
    it('records the new snapshot first and prunes beyond MAX_SNAPSHOTS', async () => {
      const { bucket, objects } = createMockBucket();
      const existing = Array.from({ length: MAX_SNAPSHOTS }, (_, i) =>
        handle(`old-${i}`, `2026-09-0${MAX_SNAPSHOTS - i}T00:00:00Z`),
      );
      seedJson(objects, 'backup-handles.json', { snapshots: existing });
      const oldest = existing[existing.length - 1].id;
      seedJson(objects, `backups/${oldest}/meta.json`, {});
      const { sandbox, createBackupMock } = createBackupSandbox();
      createBackupMock.mockResolvedValue({ id: 'fresh', dir: '/home/openclaw' });

      await createSnapshot(sandbox, bucket);

      const ids = (await getSnapshotHandles(bucket)).map((h) => h.id);
      expect(ids).toEqual(['fresh', ...existing.slice(0, MAX_SNAPSHOTS - 1).map((h) => h.id)]);
      expect(objects.has(`backups/${oldest}/meta.json`)).toBe(false);
      const legacy = JSON.parse(new TextDecoder().decode(objects.get('backup-handle.json')!.body));
      expect(legacy.id).toBe('fresh');
    });

    it('leaves existing snapshots untouched when the backup fails', async () => {
      const { bucket, objects, mocks } = createMockBucket();
      seedJson(objects, 'backup-handles.json', {
        snapshots: [handle('keep', '2026-09-01T00:00:00Z')],
      });
      const { sandbox, createBackupMock } = createBackupSandbox();
      createBackupMock.mockRejectedValue(new Error('mksquashfs failed'));

      await expect(createSnapshot(sandbox, bucket)).rejects.toThrow('mksquashfs failed');

      expect(mocks.delete).not.toHaveBeenCalled();
      expect((await getSnapshotHandles(bucket)).map((h) => h.id)).toEqual(['keep']);
    });
  });

  describe('isSnapshotGoneError', () => {
    it('recognizes expired and not-found errors by code or message', () => {
      expect(isSnapshotGoneError(expiredError())).toBe(true);
      expect(isSnapshotGoneError(new Error('Backup abc has expired (created: ...)'))).toBe(true);
      expect(isSnapshotGoneError(new Error('Backup not found: abc'))).toBe(true);
      expect(isSnapshotGoneError(new Error('Backup archive not found in R2: abc'))).toBe(true);
    });

    it('treats other errors as transient', () => {
      expect(isSnapshotGoneError(new Error('Container failed to restore backup archive'))).toBe(
        false,
      );
    });
  });

  describe('isSafeToBackup', () => {
    it('is true only when the marker and config checks pass', async () => {
      const { sandbox, execMock } = createBackupSandbox();

      execMock.mockResolvedValueOnce(createMockExecResult('', { exitCode: 0 }));
      expect(await isSafeToBackup(sandbox)).toBe(true);

      execMock.mockResolvedValueOnce(createMockExecResult('', { exitCode: 1 }));
      expect(await isSafeToBackup(sandbox)).toBe(false);
    });
  });
});
