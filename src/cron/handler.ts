import { getSandbox } from '@cloudflare/sandbox';
import type { OpenClawEnv } from '../types';
import type { Sandbox } from '../sandbox';
import { buildSandboxOptions } from '../index';
import { shouldWakeContainer, DEFAULT_LEAD_TIME_MS, CRON_STORE_R2_KEY } from './wake';
import { runScheduledBackup } from './backup';

/**
 * Handle Workers Cron Trigger: take automatic backups when due, and wake the
 * container if OpenClaw has upcoming cron jobs.
 */
export async function handleScheduled(env: OpenClawEnv): Promise<void> {
  const sandbox = getSandbox(env.Sandbox, 'openclaw', buildSandboxOptions(env));

  // Run both independently so a failure in one doesn't skip the other
  const results = await Promise.allSettled([
    runScheduledBackup(env, sandbox).then((result) => {
      if (result.status !== 'not_due' && result.status !== 'disabled') {
        console.log('[BACKUP] Scheduled backup result:', JSON.stringify(result));
      }
    }),
    wakeForCronJobs(env, sandbox),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[CRON] Scheduled task failed:', result.reason);
    }
  }
}

/**
 * Wake the container if an OpenClaw cron job is scheduled within the lead time.
 *
 * Reads the cron job store from R2 and checks if any job is scheduled to fire
 * within the lead time window. If so, wakes the container so OpenClaw's
 * internal timers can fire on time.
 *
 * Configure via environment variables:
 * - CRON_WAKE_AHEAD_MINUTES: How many minutes before a cron job to wake (default: 10)
 *
 * Configure the check interval in wrangler.jsonc triggers.crons (default: every 1 minute).
 */
async function wakeForCronJobs(env: OpenClawEnv, sandbox: Sandbox): Promise<void> {
  const cronStoreObject = await env.BACKUP_BUCKET.get(CRON_STORE_R2_KEY);
  if (!cronStoreObject) {
    console.log('[CRON] No cron store found in R2, skipping');
    return;
  }

  const cronStoreJson = await cronStoreObject.text();
  const leadMinutes = parseInt(env.CRON_WAKE_AHEAD_MINUTES || '', 10);
  const leadTimeMs = leadMinutes > 0 ? leadMinutes * 60 * 1000 : DEFAULT_LEAD_TIME_MS;
  const nowMs = Date.now();

  const earliestRun = shouldWakeContainer(cronStoreJson, nowMs, leadTimeMs);
  if (!earliestRun) {
    console.log('[CRON] No upcoming cron jobs within lead time, skipping wake');
    return;
  }

  const deltaMinutes = ((earliestRun - nowMs) / 60_000).toFixed(1);
  console.log(`[CRON] Cron job due in ${deltaMinutes}m, waking container`);

  await sandbox.ensureStarted();
  console.log('[CRON] Container woken successfully');
}
