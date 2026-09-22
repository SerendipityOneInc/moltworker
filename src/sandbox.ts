import { Sandbox as BaseSandbox } from '@cloudflare/sandbox';
import type { OpenClawEnv } from './types';
import { ensureStarted, type EnsureStartedOptions, type StartupState } from './gateway/startup';

/**
 * Sandbox Durable Object with serialized gateway startup.
 *
 * Every Worker isolate reaches the same Durable Object instance for the
 * 'openclaw' sandbox, so coordinating startup here (rather than in each
 * isolate) guarantees one restore + one gateway process even when many
 * requests arrive at once.
 */
export class Sandbox extends BaseSandbox<OpenClawEnv> {
  private startup: StartupState = { pending: null };

  /**
   * Start the gateway if it isn't running (restoring state first), shared by
   * concurrent callers. Called over RPC from the Worker.
   */
  async ensureStarted(options?: EnsureStartedOptions): Promise<void> {
    await ensureStarted(this, this.env, this.startup, options);
  }
}
