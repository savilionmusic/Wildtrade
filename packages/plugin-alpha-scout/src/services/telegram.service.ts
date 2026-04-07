/**
 * Telegram Notification Service — Pushes alerts to your phone.
 *
 * Setup:
 *   1. Message @BotFather on Telegram → /newbot → get bot token
 *   2. Message @userinfobot → get your chat ID
 *   3. Enter both in Wildtrade Settings
 *
 * Rate-limited: max 1 message per 3 seconds (Telegram limit is 30/sec).
 * Groups similar alerts to avoid spam.
 */

const TELEGRAM_API = 'https://api.telegram.org/bot';
const MIN_INTERVAL_MS = 3_000; // 3 sec between messages
const BATCH_INTERVAL_MS = 15_000; // Batch non-urgent alerts for 15 sec

// ── State ──
let telegramToken: string = '';
let telegramChatId: string = '';
let enabled = false;
let lastSentAt = 0;
let pendingBatch: string[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;

// ── Alert priority (what gets sent immediately vs batched) ──
const IMMEDIATE_TYPES = new Set([
  'smart_money_cluster',
  'smart_money_alert',
  'signal_forwarded',
  'dca_entry',
  'exit',
  'position_opened',
  'position_closed',
  'safety_alert',
]);

// ── Public API ──

export function configureTelegram(botToken: string, chatId: string): void {
  telegramToken = botToken?.trim() || '';
  telegramChatId = chatId?.trim() || '';
  enabled = !!(telegramToken && telegramChatId);

  if (enabled) {
    console.log(`[telegram] Configured — notifications will push to chat ${telegramChatId.slice(0, 4)}...`);
    sendMessage('\u{2705} *Wildtrade connected*\nYou\u2019ll receive trade alerts, smart money signals, and position updates here.');
  } else {
    console.log('[telegram] Not configured — set bot token + chat ID in Settings');
  }
}

export function isTelegramEnabled(): boolean {
  return enabled;
}

export function sendTelegramAlert(type: string, message: string): void {
  if (!enabled) return;

  const emoji = EMOJI_MAP[type] || '\u{1F514}';
  const label = type.replace(/_/g, ' ').toUpperCase();
  const formatted = `${emoji} *${label}*\n${escapeMarkdown(message)}`;

  if (IMMEDIATE_TYPES.has(type)) {
    // Send immediately (with rate limit)
    sendMessage(formatted);
  } else {
    // Batch non-urgent alerts
    pendingBatch.push(`${emoji} ${escapeMarkdown(message)}`);
    if (!batchTimer) {
      batchTimer = setTimeout(flushBatch, BATCH_INTERVAL_MS);
    }
  }
}

// ── Internal ──

const EMOJI_MAP: Record<string, string> = {
  smart_money_alert: '\u{1F9E0}',
  smart_money_cluster: '\u{1F4A1}',
  signal_forwarded: '\u{1F3AF}',
  dca_entry: '\u{1F4B0}',
  exit: '\u{1F4B8}',
  position_opened: '\u{1F4C8}',
  position_closed: '\u{1F4C9}',
  safety_alert: '\u{26A0}\u{FE0F}',
  scanner: '\u{1F50D}',
  kol_intel: '\u{1F4E2}',
  kol_signal: '\u{1F4E3}',
  wallet_intel: '\u{1F4BC}',
  new_token_detected: '\u{2728}',
  token_scanned: '\u{1F50E}',
};

async function sendMessage(text: string): Promise<void> {
  if (!enabled) return;

  // Rate limit
  const now = Date.now();
  const wait = MIN_INTERVAL_MS - (now - lastSentAt);
  if (wait > 0) {
    await new Promise(r => setTimeout(r, wait));
  }
  lastSentAt = Date.now();

  try {
    const res = await fetch(`${TELEGRAM_API}${telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.log(`[telegram] Send failed: ${(err as any).description || res.status}`);
    }
  } catch (err) {
    console.log(`[telegram] Network error: ${String(err)}`);
  }
}

function flushBatch(): void {
  batchTimer = null;
  if (pendingBatch.length === 0) return;

  const header = `\u{1F4CB} *Activity Update* (${pendingBatch.length} events)`;
  const body = pendingBatch.slice(0, 20).join('\n');
  pendingBatch = [];

  sendMessage(`${header}\n\n${body}`);
}

function escapeMarkdown(text: string): string {
  // Escape Telegram Markdown v1 special chars (but keep basic formatting)
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

// ── Two-Way: Poll for incoming user messages ──

type IncomingHandler = (text: string) => Promise<string>;
let incomingHandler: IncomingHandler | null = null;
let lastUpdateId = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Register a handler for messages sent by the user TO the bot via Telegram.
 * The handler should return the bot's text response.
 */
export function onTelegramMessage(handler: IncomingHandler): void {
  incomingHandler = handler;

  if (!enabled || pollTimer) return;

  // Start polling for updates every 5 seconds
  pollTimer = setInterval(pollUpdates, 5_000);
  console.log('[telegram] Two-way mode active — listening for user commands');
}

export function stopTelegramPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function pollUpdates(): Promise<void> {
  if (!enabled || !incomingHandler) return;

  try {
    const url = `${TELEGRAM_API}${telegramToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=0&allowed_updates=["message"]`;
    const res = await fetch(url);
    if (!res.ok) return;

    const data = await res.json() as { ok?: boolean; result?: Array<{
      update_id: number;
      message?: { text?: string; chat?: { id: number }; from?: { id: number } };
    }> };

    if (!data.ok || !data.result) return;

    for (const update of data.result) {
      lastUpdateId = update.update_id;
      const text = update.message?.text;
      const chatId = String(update.message?.chat?.id ?? '');

      // Only respond to messages from the configured chat
      if (!text || chatId !== telegramChatId) continue;

      console.log(`[telegram] Received: "${text}"`);

      try {
        const reply = await incomingHandler(text);
        if (reply) {
          await sendMessage(escapeMarkdown(reply));
        }
      } catch (err) {
        console.log(`[telegram] Handler error: ${String(err)}`);
        await sendMessage('\u274C Error processing command');
      }
    }
  } catch (err) {
    // Silent fail on poll errors
  }
}
