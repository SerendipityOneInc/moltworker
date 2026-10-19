import type { Sandbox } from '@cloudflare/sandbox';

/**
 * Persistence for /home/openclaw (config + workspace + skills) using Sandbox
 * SDK snapshots (createBackup/restoreBackup): squashfs archives in the
 * BACKUP_BUCKET R2 bucket.
 *
 * restoreBackup mounts a snapshot as a FUSE overlay (squashfuse +
 * fuse-overlayfs). We restore into a staging directory and copy it onto the
 * container's local disk instead of running from that mount: every read and
 * write through the FUSE daemons was slow, the container froze while
 * mksquashfs read the overlay during a snapshot, and SQLite's WAL (which
 * shares memory between processes via mmap of the -shm file) corrupted
 * OpenClaw's database on it.
 *
 * We keep the last MAX_SNAPSHOTS handles and fall back to older ones if the
 * newest can't be restored.
 *
 * A marker file in the container's /tmp records that the current container
 * state came from a successful restore (or that there was nothing to restore).
 * /tmp is wiped when the container restarts, so a missing marker means the
 * container may be running with empty state and must NOT be backed up —
 * otherwise a fresh install would overwrite good backups.
 */

const BACKUP_DIR = '/home/openclaw';
// Snapshots are pruned by count (MAX_SNAPSHOTS), not by TTL, so the TTL only
// matters if scheduled backups stop running. Keep it long so the last snapshot
// stays restorable for a long outage.
const BACKUP_TTL_SECONDS = 90 * 24 * 60 * 60;

/** Newest-first list of snapshot handles */
const HANDLES_KEY = 'backup-handles.json';
/** Single newest handle, kept for compatibility with older Worker versions */
const LEGACY_HANDLE_KEY = 'backup-handle.json';

export const MAX_SNAPSHOTS = 3;

export const RESTORE_MARKER = '/tmp/moltworker-state-ok';

/** Where restoreBackup mounts a snapshot before it is copied to BACKUP_DIR */
export const RESTORE_STAGING_DIR = '/var/tmp/moltworker-restore';

/**
 * Copy the mounted snapshot onto BACKUP_DIR on local disk. Copies into the
 * existing directory rather than swapping it: the sandbox server's working
 * directory is /home/openclaw/clawd (the image WORKDIR), and replacing the
 * directory would leave it in a deleted one. Restores only run in a fresh
 * container, where BACKUP_DIR holds just the image's empty skeleton. A
 * failed copy aborts startup without the restore marker, so the next attempt
 * copies again. The staging mount stays: unmounting it behind the SDK's back
 * isn't worth the risk, and nothing reads it after this.
 */
export const MATERIALIZE_RESTORE = `cp -a ${RESTORE_STAGING_DIR}/. ${BACKUP_DIR}/`;

export interface SnapshotHandle {
  id: string;
  dir: string;
  /** ISO timestamp */
  createdAt: string;
}

/**
 * Read the snapshot handle list (newest first), migrating from the legacy
 * single-handle key if needed.
 */
export async function getSnapshotHandles(bucket: R2Bucket): Promise<SnapshotHandle[]> {
  const obj = await bucket.get(HANDLES_KEY);
  if (obj) {
    const parsed = await obj.json<{ snapshots?: SnapshotHandle[] }>();
    return Array.isArray(parsed?.snapshots) ? parsed.snapshots : [];
  }

  const legacy = await bucket.get(LEGACY_HANDLE_KEY);
  if (!legacy) return [];
  const handle = await legacy.json<{ id: string; dir: string }>();
  return [{ id: handle.id, dir: handle.dir, createdAt: legacy.uploaded.toISOString() }];
}

async function storeSnapshotHandles(bucket: R2Bucket, handles: SnapshotHandle[]): Promise<void> {
  await bucket.put(HANDLES_KEY, JSON.stringify({ snapshots: handles }));
  if (handles.length > 0) {
    await bucket.put(LEGACY_HANDLE_KEY, JSON.stringify({ id: handles[0].id, dir: handles[0].dir }));
  } else {
    await bucket.delete(LEGACY_HANDLE_KEY);
  }
}

function snapshotObjectKeys(id: string): string[] {
  return [`backups/${id}/data.sqsh`, `backups/${id}/meta.json`];
}

/**
 * Whether a restoreBackup error means the snapshot can never be restored
 * (expired or deleted), as opposed to a transient failure.
 */
export function isSnapshotGoneError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (code === 'BACKUP_EXPIRED' || code === 'BACKUP_NOT_FOUND') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /BACKUP_EXPIRED|BACKUP_NOT_FOUND|has expired|not found/i.test(msg);
}

async function writeRestoreMarker(sandbox: Sandbox): Promise<void> {
  await sandbox.exec(`date -u +%Y-%m-%dT%H:%M:%SZ > ${RESTORE_MARKER}`);
}

async function unmountBackupDir(sandbox: Sandbox): Promise<void> {
  try {
    await sandbox.exec(`umount ${BACKUP_DIR} 2>/dev/null; true`);
  } catch {
    // May not be mounted
  }
}

/**
 * Whether this container's /home/openclaw was already restored (or found
 * nothing to restore) since the container started, and is still readable.
 * Containers restored by older Worker versions run on a FUSE overlay; if its
 * daemon dies the mount answers ENOTCONN and must be restored again.
 */
export async function hasRestoreMarker(sandbox: Sandbox): Promise<boolean> {
  const result = await sandbox.exec(
    `test -f ${RESTORE_MARKER} && ls ${BACKUP_DIR}/.openclaw > /dev/null`,
  );
  return result.exitCode === 0;
}

/**
 * Restore the most recent usable backup unless this container already has.
 *
 * Tries snapshots newest-first, dropping any that have expired or been
 * deleted. Transient restore errors are rethrown without trying older
 * snapshots, so a temporary failure never silently rolls state back.
 *
 * Only call this right before starting the gateway, with no gateway running
 * (see gateway/startup.ts): replacing /home/openclaw would pull files out
 * from under a running gateway and roll its state back to the snapshot.
 *
 * The snapshot is mounted at RESTORE_STAGING_DIR and copied onto local disk
 * (see the module comment for why it isn't used in place).
 *
 * Whether a restore already happened is tracked by a marker in the
 * container's /tmp rather than Worker memory, since Worker isolates come and
 * go independently of the container.
 */
export async function restoreIfNeeded(sandbox: Sandbox, bucket: R2Bucket): Promise<void> {
  if (await hasRestoreMarker(sandbox)) return;

  const handles = await getSnapshotHandles(bucket);
  const gone: SnapshotHandle[] = [];

  // Sequential on purpose: try newest first and stop at the first success
  for (const handle of handles) {
    // oxlint-disable-next-line no-await-in-loop
    await unmountBackupDir(sandbox);
    console.log(`[persistence] Restoring snapshot ${handle.id} (${handle.createdAt})...`);
    const t0 = Date.now();
    try {
      // oxlint-disable-next-line no-await-in-loop
      await sandbox.restoreBackup({ id: handle.id, dir: RESTORE_STAGING_DIR });
    } catch (err) {
      if (!isSnapshotGoneError(err)) {
        console.error(`[persistence] Restore of ${handle.id} failed:`, err);
        throw err;
      }
      console.log(`[persistence] Snapshot ${handle.id} expired/gone, trying an older one`);
      gone.push(handle);
      continue;
    }

    // oxlint-disable-next-line no-await-in-loop
    const copied = await sandbox.exec(MATERIALIZE_RESTORE);
    if (copied.exitCode !== 0) {
      throw new Error(
        `Copying snapshot ${handle.id} to ${BACKUP_DIR} failed: ${copied.stderr || copied.exitCode}`,
      );
    }

    if (gone.length > 0) {
      // oxlint-disable-next-line no-await-in-loop
      await storeSnapshotHandles(
        bucket,
        handles.filter((h) => !gone.includes(h)),
      );
    }
    // oxlint-disable-next-line no-await-in-loop
    await writeRestoreMarker(sandbox);
    console.log(`[persistence] Restore complete in ${Date.now() - t0}ms`);
    return;
  }

  if (gone.length > 0) {
    // The SDK doesn't delete expired snapshot objects, so they stay in R2
    // under backups/<id>/ for manual recovery.
    await storeSnapshotHandles(bucket, []);
    console.error(
      `[persistence] All snapshots expired or missing (${gone.map((h) => h.id).join(', ')}), starting fresh`,
    );
  } else {
    console.log('[persistence] No backups found in R2, starting fresh');
  }
  await writeRestoreMarker(sandbox);
}

/**
 * Whether it is safe to back up the container's current state: the state
 * must have come from a successful restore in this container's lifetime
 * (marker present) and the OpenClaw config must exist.
 */
export async function isSafeToBackup(sandbox: Sandbox): Promise<boolean> {
  const result = await sandbox.exec(
    `test -f ${RESTORE_MARKER} && test -s ${BACKUP_DIR}/.openclaw/openclaw.json`,
  );
  return result.exitCode === 0;
}

/**
 * Create a new snapshot of /home/openclaw (config + workspace + skills).
 *
 * The new snapshot is created and recorded before older ones are pruned, so a
 * failed backup never leaves R2 without a restorable snapshot. The SDK does
 * not delete expired snapshot objects itself, so pruned ones are removed here.
 *
 * The Sandbox SDK only allows backup of directories under /home, /workspace,
 * /tmp, or /var/tmp. The Dockerfile sets HOME=/home/openclaw and symlinks
 * /root/.openclaw and /root/clawd there.
 */
export async function createSnapshot(sandbox: Sandbox, bucket: R2Bucket): Promise<SnapshotHandle> {
  console.log('[persistence] Creating snapshot...');
  const t0 = Date.now();
  const backup = await sandbox.createBackup({ dir: BACKUP_DIR, ttl: BACKUP_TTL_SECONDS });
  const handle: SnapshotHandle = {
    id: backup.id,
    dir: backup.dir,
    createdAt: new Date().toISOString(),
  };

  const previous = await getSnapshotHandles(bucket);
  const all = [handle, ...previous.filter((h) => h.id !== handle.id)];
  const kept = all.slice(0, MAX_SNAPSHOTS);
  await storeSnapshotHandles(bucket, kept);

  const prunedKeys = all.slice(MAX_SNAPSHOTS).flatMap((h) => snapshotObjectKeys(h.id));
  if (prunedKeys.length > 0) {
    try {
      await bucket.delete(prunedKeys);
    } catch (err) {
      console.error('[persistence] Failed to delete old snapshots:', err);
    }
  }

  console.log(`[persistence] Snapshot ${handle.id} created in ${Date.now() - t0}ms`);
  return handle;
}

/**
 * Get the newest snapshot handle (for status reporting).
 */
export async function getLastSnapshot(bucket: R2Bucket): Promise<SnapshotHandle | null> {
  const [newest] = await getSnapshotHandles(bucket);
  return newest ?? null;
}
