import type { OpenClawEnv } from '../types';

const TELEGRAM_TIMEOUT_MS = 10_000;

/**
 * Send an operator alert to Telegram from the Worker.
 *
 * Goes straight to the Bot API rather than through OpenClaw's Telegram
 * channel, which runs inside the container and can't send anything while the
 * container is down or frozen. Uses the same bot as OpenClaw: sendMessage
 * doesn't interfere with the gateway's getUpdates polling.
 *
 * No-op unless both TELEGRAM_BOT_TOKEN and WATCHDOG_TELEGRAM_CHAT_ID are set.
 * Never throws: a failed alert must not break the cron run that sent it.
 * Resolves to true when Telegram accepted the message.
 */
export async function sendTelegramAlert(env: OpenClawEnv, text: string): Promise<boolean> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.WATCHDOG_TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    if (!response.ok) {
      // The URL holds the bot token, so log only the status
      console.error('[ALERT] Telegram sendMessage failed with status', response.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      '[ALERT] Telegram sendMessage failed:',
      err instanceof Error ? err.name : 'error',
    );
    return false;
  }
}
