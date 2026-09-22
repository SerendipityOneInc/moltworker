import type { Sandbox } from '@cloudflare/sandbox';
import type { OpenClawEnv } from '../types';
import { createSnapshot, getLastSnapshot, isSafeToBackup } from '../persistence';

/** Default minutes between automatic snapshots */
export const DEFAULT_SNAPSHOT_INTERVAL_MINUTES = 15;

const LOCK_KEY = 'backup-lock';
const LOCK_TTL_MS = 10 * 60 * 1000;
export const BACKUP_STATE_KEY = 'backup-state.json';

/** Last automatic snapshot attempt, so failures back off instead of retrying every minute */
export interface BackupState {
  lastAttemptMs?: number;
  lastStatus?: string;
  lastError?: string;
}

export async function getBackupState(bucket: R2Bucket): Promise<BackupState> {
  const obj = await bucket.get(BACKUP_STATE_KEY);
  return obj ? obj.json<BackupState>() : {};
}

/**
 * Milliseconds between automatic snapshots, from BACKUP_INTERVAL_MINUTES.
 * 0 disables automatic snapshots.
 */
export function getSnapshotIntervalMs(env: OpenClawEnv): number {
  const raw = env.BACKUP_INTERVAL_MINUTES;
  const minutes = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  const valid = Number.isFinite(minutes) && minutes >= 0;
  return (valid ? minutes : DEFAULT_SNAPSHOT_INTERVAL_MINUTES) * 60 * 1000;
}

/**
 * Whether a backup taken at `lastMs` is old enough to need a new one.
 * A missing previous backup is always due.
 */
export function isDue(lastMs: number | null, intervalMs: number, nowMs: number): boolean {
  if (intervalMs <= 0) return false;
  if (lastMs === null) return true;
  return nowMs - lastMs >= intervalMs;
}

async function acquireLock(bucket: R2Bucket, nowMs: number): Promise<boolean> {
  const existing = await bucket.get(LOCK_KEY);
  if (existing) {
    const { expiresAt } = await existing.json<{ expiresAt: number }>();
    if (expiresAt > nowMs) return false;
  }
  await bucket.put(LOCK_KEY, JSON.stringify({ expiresAt: nowMs + LOCK_TTL_MS }));
  return true;
}

export type ScheduledBackupResult =
  | { status: 'disabled' | 'not_due' | 'not_running' | 'locked' | 'unsafe' }
  | { status: 'done'; snapshotId: string }
  | { status: 'failed'; error: string };

/**
 * Take a snapshot if the interval since the last one has elapsed.
 *
 * Runs from the Workers Cron Trigger. Only touches the container when a
 * snapshot is actually due and the container is already running, and refuses to back up a container whose state
 * didn't come from a successful restore (see isSafeToBackup). Failed or
 * refused attempts are retried after another full interval.
 *
 * Automatic backups only run when the container is kept alive: in sleep mode
 * the RPCs would count as activity and keep the container from sleeping.
 */
export async function runScheduledBackup(
  env: OpenClawEnv,
  sandbox: Sandbox,
  nowMs: number = Date.now(),
): Promise<ScheduledBackupResult> {
  const sleepAfter = env.SANDBOX_SLEEP_AFTER?.toLowerCase() || 'never';
  const intervalMs = getSnapshotIntervalMs(env);
  if (sleepAfter !== 'never' || intervalMs <= 0) {
    return { status: 'disabled' };
  }

  const bucket = env.BACKUP_BUCKET;
  const [state, lastSnapshot] = await Promise.all([
    getBackupState(bucket),
    getLastSnapshot(bucket),
  ]);
  const lastSuccessMs = lastSnapshot ? Date.parse(lastSnapshot.createdAt) : null;
  if (
    !isDue(lastSuccessMs, intervalMs, nowMs) ||
    !isDue(state.lastAttemptMs ?? null, intervalMs, nowMs)
  ) {
    return { status: 'not_due' };
  }

  // Any exec/process RPC would start a stopped container, so check the
  // stored container state first — there is nothing to back up anyway.
  const { status } = await sandbox.getState();
  if (status !== 'running' && status !== 'healthy') {
    return { status: 'not_running' };
  }

  if (!(await acquireLock(bucket, nowMs))) {
    console.log('[BACKUP] Another backup is in progress, skipping');
    return { status: 'locked' };
  }

  const nextState: BackupState = { lastAttemptMs: nowMs };
  try {
    if (!(await isSafeToBackup(sandbox))) {
      console.warn(
        '[BACKUP] Container state was not restored in this container lifetime, refusing to back up',
      );
      nextState.lastStatus = 'unsafe';
      return { status: 'unsafe' };
    }

    try {
      const handle = await createSnapshot(sandbox, bucket);
      nextState.lastStatus = 'ok';
      return { status: 'done', snapshotId: handle.id };
    } catch (err) {
      console.error('[BACKUP] Snapshot failed:', err);
      const error = err instanceof Error ? err.message : String(err);
      nextState.lastStatus = 'failed';
      nextState.lastError = error;
      return { status: 'failed', error };
    }
  } finally {
    await bucket.put(BACKUP_STATE_KEY, JSON.stringify(nextState));
    await bucket.delete(LOCK_KEY);
  }
}
