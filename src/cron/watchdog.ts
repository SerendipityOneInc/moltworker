import type { OpenClawEnv } from '../types';
import type { Sandbox } from '../sandbox';
import { isGatewayServing } from '../gateway/process';
import { sendTelegramAlert } from '../notify/telegram';

export const WATCHDOG_STATE_KEY = 'watchdog-state.json';

/** How long a health probe may take before the container counts as unresponsive */
export const PROBE_TIMEOUT_MS = 30_000;
/** How long the watchdog waits for ensureStarted / resetContainer */
const ACTION_TIMEOUT_MS = 120_000;
/** Container answers nothing (exec hangs or fails) for this long: destroy it */
export const UNRESPONSIVE_THRESHOLD_MS = 3 * 60_000;
/**
 * Gateway process exists but doesn't answer /healthz for this long: kill and
 * restart it. Longer than a normal start, which can include a restore and a
 * one-off doctor migration after an upgrade.
 */
export const NOT_SERVING_THRESHOLD_MS = 10 * 60_000;
/** After a restart or reset, give the new gateway this long before acting again */
export const ACTION_COOLDOWN_MS = 10 * 60_000;
/** While the gateway stays down, remind the operator at most this often */
export const REPEAT_ALERT_MS = 30 * 60_000;

/** Current incident, kept in R2 so it survives across cron runs and isolates */
export interface WatchdogState {
  /** First failed check of the current incident */
  unhealthySince?: number;
  /** Last restart or reset the watchdog triggered */
  lastActionMs?: number;
  /** Last alert sent for this incident */
  lastAlertMs?: number;
}

export type GatewayHealth = 'healthy' | 'not_serving' | 'unresponsive';

export type WatchdogResult =
  | { status: 'disabled' }
  | { status: 'running' }
  | { status: 'recovered'; downMs: number }
  | { status: 'started' }
  | { status: 'restarted'; downMs: number }
  | { status: 'reset'; downMs: number }
  | { status: 'down'; health: GatewayHealth; downMs: number };

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Probe the gateway's /healthz with a deadline. A frozen container (out of memory,
 * CPU starved) keeps its processes but never answers exec, so a probe without
 * a deadline would hang the cron run instead of reporting the problem.
 */
export async function checkGatewayHealth(sandbox: Sandbox): Promise<GatewayHealth> {
  try {
    const serving = await withTimeout(isGatewayServing(sandbox), PROBE_TIMEOUT_MS);
    return serving ? 'healthy' : 'not_serving';
  } catch {
    return 'unresponsive';
  }
}

async function getState(bucket: R2Bucket): Promise<WatchdogState> {
  try {
    const obj = await bucket.get(WATCHDOG_STATE_KEY);
    return obj ? await obj.json<WatchdogState>() : {};
  } catch (err) {
    console.error('[WATCHDOG] Failed to read state:', err);
    return {};
  }
}

function minutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

/**
 * Keep the gateway up: start it when it isn't running, restart it when it
 * stops answering, and replace the container when the container itself hangs.
 *
 * Runs from the Workers Cron Trigger every minute. Levels:
 * - /healthz fails and no gateway process: start it (shares the Sandbox Durable
 *   Object's startup lock with requests, so it never starts twice).
 * - /healthz fails for NOT_SERVING_THRESHOLD_MS although a process exists:
 *   the gateway is wedged; ensureStarted({ recover: true }) kills and restarts it.
 * - Exec times out or fails for UNRESPONSIVE_THRESHOLD_MS: the container is
 *   frozen; destroy it so the next run starts a fresh one from the latest
 *   snapshot (losing changes since that snapshot).
 *
 * Sends Telegram alerts (WATCHDOG_TELEGRAM_CHAT_ID) for each action, for an
 * outage that persists, and when the gateway comes back after one of those.
 * Only runs when the container is kept alive; in sleep mode this would keep
 * the container from sleeping.
 */
export async function runGatewayWatchdog(
  env: OpenClawEnv,
  sandbox: Sandbox,
  nowMs: number = Date.now(),
): Promise<WatchdogResult> {
  const sleepAfter = env.SANDBOX_SLEEP_AFTER?.toLowerCase() || 'never';
  if (sleepAfter !== 'never') {
    return { status: 'disabled' };
  }

  const bucket = env.BACKUP_BUCKET;
  const state = await getState(bucket);
  const health = await checkGatewayHealth(sandbox);

  if (health === 'healthy') {
    if (state.unhealthySince === undefined) return { status: 'running' };
    const downMs = nowMs - state.unhealthySince;
    // Only report recoveries the operator was told about; short blips stay quiet
    if (state.lastAlertMs !== undefined) {
      await sendTelegramAlert(env, `✅ Moltworker 网关已恢复，中断约 ${minutes(downMs)} 分钟。`);
    }
    await bucket.delete(WATCHDOG_STATE_KEY);
    return { status: 'recovered', downMs };
  }

  const unhealthySince = state.unhealthySince ?? nowMs;
  const downMs = nowMs - unhealthySince;
  const coolingDown =
    state.lastActionMs !== undefined && nowMs - state.lastActionMs < ACTION_COOLDOWN_MS;
  const next: WatchdogState = { ...state, unhealthySince };
  let result: WatchdogResult = { status: 'down', health, downMs };
  let alert: string | null = null;

  if (health === 'not_serving') {
    const recover = downMs >= NOT_SERVING_THRESHOLD_MS && !coolingDown;
    try {
      const started = await withTimeout(
        sandbox.ensureStarted({ waitForReady: false, recover }),
        ACTION_TIMEOUT_MS,
      );
      if (started) {
        next.lastActionMs = nowMs;
        if (recover) {
          result = { status: 'restarted', downMs };
          alert = `⚠️ Moltworker 网关 ${minutes(downMs)} 分钟不响应 HTTP，已杀掉进程并重启。`;
        } else {
          result = { status: 'started' };
          alert = '⚠️ Moltworker 网关进程不在运行，已重新启动。';
        }
      }
    } catch (err) {
      console.error('[WATCHDOG] Failed to start the gateway:', err);
    }
  } else if (downMs >= UNRESPONSIVE_THRESHOLD_MS && !coolingDown) {
    next.lastActionMs = nowMs;
    try {
      await withTimeout(sandbox.resetContainer(), ACTION_TIMEOUT_MS);
    } catch (err) {
      console.error('[WATCHDOG] Failed to reset the container:', err);
    }
    result = { status: 'reset', downMs };
    alert =
      `🚨 Moltworker 容器 ${minutes(downMs)} 分钟无响应，已强制重置。` +
      '新容器会从最近的快照恢复，快照之后的改动会丢失。';
  }

  if (
    alert === null &&
    downMs >= UNRESPONSIVE_THRESHOLD_MS &&
    (state.lastAlertMs === undefined || nowMs - state.lastAlertMs >= REPEAT_ALERT_MS)
  ) {
    const reason = health === 'unresponsive' ? '容器无响应' : '网关不响应 HTTP';
    alert = `⚠️ Moltworker 网关仍不可用（${reason}），已持续 ${minutes(downMs)} 分钟。`;
  }

  if (alert !== null) {
    await sendTelegramAlert(env, alert);
    next.lastAlertMs = nowMs;
  }

  await bucket.put(WATCHDOG_STATE_KEY, JSON.stringify(next));
  return result;
}
