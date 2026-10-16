import { describe, it, expect, vi } from 'vitest';
import type { Sandbox } from '../sandbox';
import { runGatewayWatchdog } from './watchdog';
import { createMockEnv } from '../test-utils';

function createWatchdogSandbox(started: boolean) {
  const ensureStartedMock = vi.fn().mockResolvedValue(started);
  const sandbox = { ensureStarted: ensureStartedMock } as unknown as Sandbox;
  return { sandbox, ensureStartedMock };
}

describe('runGatewayWatchdog', () => {
  it('starts the gateway without waiting for it when the container is kept alive', async () => {
    const { sandbox, ensureStartedMock } = createWatchdogSandbox(true);

    const result = await runGatewayWatchdog(createMockEnv(), sandbox);

    expect(result).toEqual({ status: 'started' });
    expect(ensureStartedMock).toHaveBeenCalledWith({ waitForReady: false });
  });

  it('reports a gateway that is already running', async () => {
    const { sandbox } = createWatchdogSandbox(false);

    const result = await runGatewayWatchdog(
      createMockEnv({ SANDBOX_SLEEP_AFTER: 'never' }),
      sandbox,
    );

    expect(result).toEqual({ status: 'running' });
  });

  it('never touches a container that is allowed to sleep', async () => {
    const { sandbox, ensureStartedMock } = createWatchdogSandbox(true);

    const result = await runGatewayWatchdog(createMockEnv({ SANDBOX_SLEEP_AFTER: '10m' }), sandbox);

    expect(result).toEqual({ status: 'disabled' });
    expect(ensureStartedMock).not.toHaveBeenCalled();
  });

  it('propagates startup failures so the cron handler logs them', async () => {
    const { sandbox, ensureStartedMock } = createWatchdogSandbox(true);
    ensureStartedMock.mockRejectedValue(new Error('restore failed'));

    await expect(runGatewayWatchdog(createMockEnv(), sandbox)).rejects.toThrow('restore failed');
  });
});
