import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Sandbox } from '@cloudflare/sandbox';
import { ensureStarted, type StartupState } from './startup';
import { killGateway } from './process';
import { RESTORE_MARKER } from '../persistence';
import {
  createMockBucket,
  createMockEnv,
  createMockExecResult,
  seedJson,
  suppressConsole,
} from '../test-utils';

vi.mock('./process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./process')>()),
  killGateway: vi.fn().mockResolvedValue(undefined),
}));

interface FakeContainer {
  sandbox: Sandbox;
  startProcessMock: ReturnType<typeof vi.fn>;
  restoreBackupMock: ReturnType<typeof vi.fn>;
  waitForPortMock: ReturnType<typeof vi.fn>;
  state: { portOpen: boolean; marker: boolean; gatewayRunning: boolean };
}

/** A container whose process list, port and restore marker change as the sandbox is used */
function createFakeContainer(initial: Partial<FakeContainer['state']> = {}): FakeContainer {
  const state = { portOpen: false, marker: false, gatewayRunning: false, ...initial };
  const waitForPortMock = vi.fn().mockResolvedValue(undefined);
  const gatewayProcess = () => ({
    id: 'proc-gateway',
    command: '/usr/local/bin/start-openclaw.sh',
    status: 'running',
    waitForPort: waitForPortMock,
    getLogs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  });

  const startProcessMock = vi.fn(async () => {
    state.gatewayRunning = true;
    return gatewayProcess();
  });
  const restoreBackupMock = vi.fn().mockResolvedValue({ success: true });

  const sandbox = {
    listProcesses: vi.fn(async () => (state.gatewayRunning ? [gatewayProcess()] : [])),
    startProcess: startProcessMock,
    restoreBackup: restoreBackupMock,
    exec: vi.fn(async (cmd: string) => {
      if (cmd.startsWith('nc -z')) {
        return createMockExecResult('', { exitCode: state.portOpen ? 0 : 1 });
      }
      if (cmd === `test -f ${RESTORE_MARKER}`) {
        return createMockExecResult('', { exitCode: state.marker ? 0 : 1 });
      }
      if (cmd.includes(RESTORE_MARKER)) {
        state.marker = true;
      }
      return createMockExecResult();
    }),
  } as unknown as Sandbox;

  return { sandbox, startProcessMock, restoreBackupMock, waitForPortMock, state };
}

function envWithSnapshot() {
  const { bucket, objects } = createMockBucket();
  seedJson(objects, 'backup-handles.json', {
    snapshots: [{ id: 'snap-1', dir: '/home/openclaw', createdAt: '2026-09-22T00:00:00Z' }],
  });
  return createMockEnv({ BACKUP_BUCKET: bucket });
}

describe('ensureStarted', () => {
  let startup: StartupState;

  beforeEach(() => {
    suppressConsole();
    vi.mocked(killGateway).mockClear();
    startup = { pending: null };
  });

  it('restores and starts the gateway once for concurrent callers', async () => {
    const env = envWithSnapshot();
    const { sandbox, startProcessMock, restoreBackupMock } = createFakeContainer();

    await Promise.all([
      ensureStarted(sandbox, env, startup, { waitForReady: false }),
      ensureStarted(sandbox, env, startup, { waitForReady: false }),
      ensureStarted(sandbox, env, startup, { waitForReady: false }),
    ]);

    expect(restoreBackupMock).toHaveBeenCalledTimes(1);
    expect(startProcessMock).toHaveBeenCalledTimes(1);
    expect(startup.pending).toBeNull();
  });

  it('restores before starting the gateway', async () => {
    const env = envWithSnapshot();
    const { sandbox, startProcessMock, restoreBackupMock } = createFakeContainer();

    await ensureStarted(sandbox, env, startup, { waitForReady: false });

    expect(restoreBackupMock.mock.invocationCallOrder[0]).toBeLessThan(
      startProcessMock.mock.invocationCallOrder[0],
    );
  });

  it('never restores while a gateway is running', async () => {
    const env = envWithSnapshot();
    const { sandbox, startProcessMock, restoreBackupMock } = createFakeContainer({
      gatewayRunning: true,
    });

    await ensureStarted(sandbox, env, startup, { waitForReady: false });

    expect(restoreBackupMock).not.toHaveBeenCalled();
    expect(startProcessMock).not.toHaveBeenCalled();
  });

  it('does nothing when the gateway port is already open', async () => {
    const env = envWithSnapshot();
    const { sandbox, startProcessMock, restoreBackupMock } = createFakeContainer({
      portOpen: true,
    });

    await ensureStarted(sandbox, env, startup, { waitForReady: false });

    expect(restoreBackupMock).not.toHaveBeenCalled();
    expect(startProcessMock).not.toHaveBeenCalled();
  });

  it('starts without restoring when this container was already restored', async () => {
    const env = envWithSnapshot();
    const { sandbox, startProcessMock, restoreBackupMock } = createFakeContainer({
      marker: true,
    });

    await ensureStarted(sandbox, env, startup, { waitForReady: false });

    expect(restoreBackupMock).not.toHaveBeenCalled();
    expect(startProcessMock).toHaveBeenCalledTimes(1);
  });

  it('does not start a blank gateway when restore fails, and retries later', async () => {
    const env = envWithSnapshot();
    const { sandbox, startProcessMock, restoreBackupMock } = createFakeContainer();
    restoreBackupMock.mockRejectedValueOnce(new Error('container unreachable'));

    await expect(ensureStarted(sandbox, env, startup, { waitForReady: false })).rejects.toThrow(
      'container unreachable',
    );
    expect(startProcessMock).not.toHaveBeenCalled();
    expect(startup.pending).toBeNull();

    await ensureStarted(sandbox, env, startup, { waitForReady: false });
    expect(startProcessMock).toHaveBeenCalledTimes(1);
  });

  it('waits for the gateway port by default', async () => {
    const env = envWithSnapshot();
    const { sandbox, waitForPortMock } = createFakeContainer();

    await ensureStarted(sandbox, env, startup);

    expect(waitForPortMock).toHaveBeenCalledTimes(1);
  });

  describe('recover', () => {
    it('kills stale processes once and restarts for concurrent callers', async () => {
      const env = envWithSnapshot();
      const { sandbox, startProcessMock, restoreBackupMock } = createFakeContainer({
        gatewayRunning: true,
        marker: true,
      });
      vi.mocked(killGateway).mockImplementation(async () => {
        // Dead gateway processes disappear once killed
        (sandbox.listProcesses as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      });

      await Promise.all([
        ensureStarted(sandbox, env, startup, { waitForReady: false, recover: true }),
        ensureStarted(sandbox, env, startup, { waitForReady: false, recover: true }),
      ]);

      expect(killGateway).toHaveBeenCalledTimes(1);
      expect(startProcessMock).toHaveBeenCalledTimes(1);
      // The container's files are intact after a crash, so no rollback
      expect(restoreBackupMock).not.toHaveBeenCalled();
    });

    it('leaves a gateway that is listening again alone', async () => {
      const env = envWithSnapshot();
      const { sandbox, startProcessMock } = createFakeContainer({
        gatewayRunning: true,
        portOpen: true,
      });

      await ensureStarted(sandbox, env, startup, { waitForReady: false, recover: true });

      expect(killGateway).not.toHaveBeenCalled();
      expect(startProcessMock).not.toHaveBeenCalled();
    });
  });
});
