import type { OpenClawEnv } from '../types';
import type { Sandbox } from '../sandbox';

export type WatchdogResult = { status: 'disabled' } | { status: 'running' } | { status: 'started' };

/**
 * Start the gateway if it isn't running.
 *
 * Runs from the Workers Cron Trigger. Without it a container that dies (a
 * platform reset, an OOM kill) stays down until a browser or app request
 * arrives, and channels that poll from inside the gateway, like Telegram,
 * stay offline meanwhile.
 *
 * Goes through the Sandbox Durable Object's ensureStarted, so it shares the
 * startup lock with requests: a gateway that is already starting (restore,
 * doctor migration) is never started twice. Only runs when the container is
 * kept alive; in sleep mode this would keep the container from sleeping.
 */
export async function runGatewayWatchdog(
  env: OpenClawEnv,
  sandbox: Sandbox,
): Promise<WatchdogResult> {
  const sleepAfter = env.SANDBOX_SLEEP_AFTER?.toLowerCase() || 'never';
  if (sleepAfter !== 'never') {
    return { status: 'disabled' };
  }

  const started = await sandbox.ensureStarted({ waitForReady: false });
  return { status: started ? 'started' : 'running' };
}
