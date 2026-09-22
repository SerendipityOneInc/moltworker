import type { Sandbox } from '@cloudflare/sandbox';
import type { OpenClawEnv } from '../types';
import { GATEWAY_PORT, STARTUP_TIMEOUT_MS } from '../config';
import { restoreIfNeeded } from '../persistence';
import {
  ensureGateway,
  findExistingGatewayProcess,
  isGatewayPortOpen,
  killGateway,
} from './process';

/**
 * In-flight startup shared by concurrent callers. Lives on the Sandbox
 * Durable Object instance, which is the single place all Worker isolates
 * reach for a given sandbox, so it serializes startup across the whole
 * deployment.
 */
export interface StartupState {
  pending: Promise<void> | null;
}

export interface EnsureStartedOptions {
  /** Wait for the gateway port before returning (default true) */
  waitForReady?: boolean;
  /**
   * The caller saw the gateway stop listening: if the port is still closed
   * once this caller holds the lock, kill the stale processes and start fresh.
   */
  recover?: boolean;
}

/**
 * Start the gateway if it isn't running, restoring /home/openclaw first.
 *
 * Restore only ever happens here, with no gateway running: restoreBackup
 * remounts the directory, so doing it under a running gateway would roll its
 * state back and detach its later writes from the backup.
 */
async function startIfNeeded(sandbox: Sandbox, env: OpenClawEnv, recover: boolean): Promise<void> {
  if (await isGatewayPortOpen(sandbox)) return;
  if (recover) {
    // Checked under the lock, so a gateway another caller just restarted
    // is never killed
    await killGateway(sandbox);
  } else if (await findExistingGatewayProcess(sandbox)) {
    return;
  }

  // Don't start with empty state if a restore fails — throw so the caller
  // reports the error and retries, instead of running a blank gateway.
  await restoreIfNeeded(sandbox, env.BACKUP_BUCKET);
  await ensureGateway(sandbox, env, { waitForReady: false });
}

/**
 * Make sure the gateway is running, starting it at most once no matter how
 * many requests arrive at the same time.
 *
 * Concurrent callers share one startup. With `waitForReady` (the default),
 * each caller then waits for the gateway port on its own.
 */
export async function ensureStarted(
  sandbox: Sandbox,
  env: OpenClawEnv,
  state: StartupState,
  options?: EnsureStartedOptions,
): Promise<void> {
  if (!state.pending) {
    state.pending = startIfNeeded(sandbox, env, options?.recover === true).finally(() => {
      state.pending = null;
    });
  }
  await state.pending;

  if (options?.waitForReady !== false) {
    await waitForGateway(sandbox);
  }
}

/**
 * Wait for the gateway port without starting anything, so a gateway that
 * exits mid-startup is reported rather than restarted outside the lock.
 */
async function waitForGateway(sandbox: Sandbox): Promise<void> {
  const process = await findExistingGatewayProcess(sandbox);
  if (process) {
    await process.waitForPort(GATEWAY_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
    return;
  }
  if (!(await isGatewayPortOpen(sandbox))) {
    throw new Error('Gateway process exited during startup');
  }
}
