import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Sandbox } from '../sandbox';
import {
  runGatewayWatchdog,
  WATCHDOG_STATE_KEY,
  UNRESPONSIVE_THRESHOLD_MS,
  NOT_SERVING_THRESHOLD_MS,
  ACTION_COOLDOWN_MS,
  REPEAT_ALERT_MS,
  PROBE_TIMEOUT_MS,
  type WatchdogState,
} from './watchdog';
import { createMockEnv, createMockExecResult } from '../test-utils';

const NOW = 1_800_000_000_000;

function createBucket(initial?: WatchdogState) {
  const store = new Map<string, string>();
  if (initial) store.set(WATCHDOG_STATE_KEY, JSON.stringify(initial));
  const bucket = {
    get: vi.fn(async (key: string) => {
      const value = store.get(key);
      return value === undefined ? null : { json: async () => JSON.parse(value) };
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
  const state = (): WatchdogState | undefined => {
    const value = store.get(WATCHDOG_STATE_KEY);
    return value === undefined ? undefined : JSON.parse(value);
  };
  return { bucket: bucket as unknown as R2Bucket, state };
}

type Probe = 'open' | 'closed' | 'hang' | 'error';

function createSandbox(probe: Probe, started = false) {
  const exec = vi.fn(() => {
    if (probe === 'hang') return new Promise(() => {});
    if (probe === 'error') return Promise.reject(new Error('Network connection lost.'));
    return Promise.resolve(createMockExecResult('', { exitCode: probe === 'open' ? 0 : 1 }));
  });
  const ensureStarted = vi.fn().mockResolvedValue(started);
  const resetContainer = vi.fn().mockResolvedValue(undefined);
  const sandbox = { exec, ensureStarted, resetContainer } as unknown as Sandbox;
  return { sandbox, ensureStarted, resetContainer };
}

function createEnv(bucket: R2Bucket, overrides = {}) {
  return createMockEnv({
    BACKUP_BUCKET: bucket,
    TELEGRAM_BOT_TOKEN: 'bot-token',
    WATCHDOG_TELEGRAM_CHAT_ID: '42',
    ...overrides,
  });
}

describe('runGatewayWatchdog', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function alerts(): string[] {
    return fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).text);
  }

  it('never touches a container that is allowed to sleep', async () => {
    const { bucket } = createBucket();
    const { sandbox, ensureStarted } = createSandbox('closed', true);

    const result = await runGatewayWatchdog(
      createEnv(bucket, { SANDBOX_SLEEP_AFTER: '10m' }),
      sandbox,
      NOW,
    );

    expect(result).toEqual({ status: 'disabled' });
    expect(ensureStarted).not.toHaveBeenCalled();
  });

  it('does nothing while the gateway answers', async () => {
    const { bucket, state } = createBucket();
    const { sandbox, ensureStarted } = createSandbox('open');

    const result = await runGatewayWatchdog(createEnv(bucket), sandbox, NOW);

    expect(result).toEqual({ status: 'running' });
    expect(ensureStarted).not.toHaveBeenCalled();
    expect(state()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('starts a gateway that is not running and alerts', async () => {
    const { bucket, state } = createBucket();
    const { sandbox, ensureStarted } = createSandbox('closed', true);

    const result = await runGatewayWatchdog(createEnv(bucket), sandbox, NOW);

    expect(result).toEqual({ status: 'started' });
    expect(ensureStarted).toHaveBeenCalledWith({ waitForReady: false, recover: false });
    expect(alerts()).toEqual([expect.stringContaining('已重新启动')]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.telegram.org/botbot-token/sendMessage');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).chat_id).toBe('42');
    expect(state()).toEqual({ unhealthySince: NOW, lastActionMs: NOW, lastAlertMs: NOW });
  });

  it('waits quietly while a starting gateway has not opened its port yet', async () => {
    const { bucket, state } = createBucket({ unhealthySince: NOW - 2 * 60_000 });
    const { sandbox, ensureStarted } = createSandbox('closed', false);

    const result = await runGatewayWatchdog(createEnv(bucket), sandbox, NOW);

    expect(result).toEqual({ status: 'down', health: 'not_serving', downMs: 2 * 60_000 });
    expect(ensureStarted).toHaveBeenCalledWith({ waitForReady: false, recover: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state()?.unhealthySince).toBe(NOW - 2 * 60_000);
  });

  it('restarts a gateway whose port stays closed past the threshold', async () => {
    const since = NOW - NOT_SERVING_THRESHOLD_MS;
    const { bucket } = createBucket({ unhealthySince: since, lastAlertMs: NOW - 60_000 });
    const { sandbox, ensureStarted } = createSandbox('closed', true);

    const result = await runGatewayWatchdog(createEnv(bucket), sandbox, NOW);

    expect(result).toEqual({ status: 'restarted', downMs: NOT_SERVING_THRESHOLD_MS });
    expect(ensureStarted).toHaveBeenCalledWith({ waitForReady: false, recover: true });
    expect(alerts()).toEqual([expect.stringContaining('已杀掉进程并重启')]);
  });

  it('treats a probe that never returns as an unresponsive container', async () => {
    vi.useFakeTimers();
    const { bucket, state } = createBucket();
    const { sandbox, ensureStarted, resetContainer } = createSandbox('hang');

    const run = runGatewayWatchdog(createEnv(bucket), sandbox, NOW);
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);

    expect(await run).toEqual({ status: 'down', health: 'unresponsive', downMs: 0 });
    expect(ensureStarted).not.toHaveBeenCalled();
    expect(resetContainer).not.toHaveBeenCalled();
    expect(state()).toEqual({ unhealthySince: NOW });
  });

  it('resets a container that stays unresponsive past the threshold', async () => {
    const since = NOW - UNRESPONSIVE_THRESHOLD_MS;
    const { bucket, state } = createBucket({ unhealthySince: since });
    const { sandbox, resetContainer } = createSandbox('error');

    const result = await runGatewayWatchdog(createEnv(bucket), sandbox, NOW);

    expect(result).toEqual({ status: 'reset', downMs: UNRESPONSIVE_THRESHOLD_MS });
    expect(resetContainer).toHaveBeenCalledOnce();
    expect(alerts()).toEqual([expect.stringContaining('已强制重置')]);
    expect(state()).toEqual({ unhealthySince: since, lastActionMs: NOW, lastAlertMs: NOW });
  });

  it('does not reset again during the cooldown, and reminds at most every 30 minutes', async () => {
    const since = NOW - 20 * 60_000;
    const { bucket } = createBucket({
      unhealthySince: since,
      lastActionMs: NOW - ACTION_COOLDOWN_MS + 60_000,
      lastAlertMs: NOW - REPEAT_ALERT_MS + 60_000,
    });
    const { sandbox, resetContainer } = createSandbox('error');

    const result = await runGatewayWatchdog(createEnv(bucket), sandbox, NOW);

    expect(result).toEqual({ status: 'down', health: 'unresponsive', downMs: 20 * 60_000 });
    expect(resetContainer).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a reminder when the outage outlasts the repeat interval', async () => {
    const { bucket } = createBucket({
      unhealthySince: NOW - 40 * 60_000,
      lastActionMs: NOW - 60_000,
      lastAlertMs: NOW - REPEAT_ALERT_MS,
    });
    const { sandbox } = createSandbox('error');

    await runGatewayWatchdog(createEnv(bucket), sandbox, NOW);

    expect(alerts()).toEqual([expect.stringContaining('已持续 40 分钟')]);
  });

  it('reports a recovery the operator was alerted about and clears the incident', async () => {
    const { bucket, state } = createBucket({
      unhealthySince: NOW - 12 * 60_000,
      lastActionMs: NOW - 5 * 60_000,
      lastAlertMs: NOW - 5 * 60_000,
    });
    const { sandbox } = createSandbox('open');

    const result = await runGatewayWatchdog(createEnv(bucket), sandbox, NOW);

    expect(result).toEqual({ status: 'recovered', downMs: 12 * 60_000 });
    expect(alerts()).toEqual([expect.stringContaining('已恢复，中断约 12 分钟')]);
    expect(state()).toBeUndefined();
  });

  it('clears a short blip without alerting', async () => {
    const { bucket, state } = createBucket({ unhealthySince: NOW - 60_000 });
    const { sandbox } = createSandbox('open');

    const result = await runGatewayWatchdog(createEnv(bucket), sandbox, NOW);

    expect(result).toEqual({ status: 'recovered', downMs: 60_000 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state()).toBeUndefined();
  });

  it('keeps working when alerts are not configured or Telegram fails', async () => {
    const { bucket } = createBucket();
    const { sandbox } = createSandbox('closed', true);
    fetchMock.mockRejectedValue(new Error('network'));

    await expect(runGatewayWatchdog(createEnv(bucket), sandbox, NOW)).resolves.toEqual({
      status: 'started',
    });

    fetchMock.mockClear();
    const { bucket: bucket2 } = createBucket();
    await runGatewayWatchdog(
      createEnv(bucket2, { WATCHDOG_TELEGRAM_CHAT_ID: undefined }),
      createSandbox('closed', true).sandbox,
      NOW,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs and records a failed start instead of throwing', async () => {
    const { bucket, state } = createBucket();
    const { sandbox, ensureStarted } = createSandbox('closed');
    ensureStarted.mockRejectedValue(new Error('restore failed'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runGatewayWatchdog(createEnv(bucket), sandbox, NOW);

    expect(result).toEqual({ status: 'down', health: 'not_serving', downMs: 0 });
    expect(errorSpy).toHaveBeenCalled();
    expect(state()).toEqual({ unhealthySince: NOW });
    errorSpy.mockRestore();
  });
});
