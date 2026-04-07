// ── Settings field keys (inputs + selects) ──
const CONFIG_FIELDS = [
  'OPENROUTER_API_KEY', 'FINDER_MODEL', 'TRADER_MODEL', 'AUDITOR_MODEL',
  'WALLET_PUBLIC_KEY', 'WALLET_PRIVATE_KEY',
  'SOLANA_RPC_HELIUS', 'HELIUS_API_KEY', 'SOLANA_RPC_QUICKNODE',
  'MAX_POSITION_SIZE_SOL', 'TOTAL_BUDGET_SOL', 'MIN_SCORE_THRESHOLD',
  'JUPITER_SLIPPAGE_BPS', 'RUGCHECK_MIN_SCORE',
  'TWITTER_BEARER_TOKEN', 'TWITTER_KOL_USER_IDS', 'SMART_MONEY_WALLETS',
];

const TOGGLE_FIELDS = ['PAPER_TRADING', 'AUTONOMOUS_MODE'];

// ── State ──
let botRunning = false;
let logs = [];

// ── Tab navigation ──
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ── Chat enter key ──
document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') app.sendChat();
});

// ── App API ──
const app = {
  async toggleBot() {
    if (botRunning) {
      await window.wildtrade.stopBot();
    } else {
      await window.wildtrade.startBot();
    }
  },

  async saveSettings() {
    const config = {};

    CONFIG_FIELDS.forEach(key => {
      const el = document.getElementById(`cfg-${key}`);
      if (el) config[key] = el.value;
    });

    TOGGLE_FIELDS.forEach(key => {
      const el = document.getElementById(`cfg-${key}`);
      if (el) config[key] = el.checked;
    });

    await window.wildtrade.saveConfig(config);
    updateDashboardFromConfig(config);

    const toast = document.getElementById('save-toast');
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 2000);
  },

  clearLogs() {
    logs = [];
    document.getElementById('log-container').innerHTML = '';
    document.getElementById('dashboard-logs').innerHTML = '';
  },

  // ── Chat ──
  async sendChat() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    addChatMessage('user', text);
    showTypingIndicator();

    const result = await window.wildtrade.chatSend(text);
    removeTypingIndicator();

    if (result.error) {
      addChatMessage('bot', `<span style="color:#ef4444">${escapeHtml(result.error)}</span>`);
    } else {
      addChatMessage('bot', formatMarkdown(result.reply));
    }
  },

  async runDiagnostics() {
    addChatMessage('user', 'Run a full diagnostics check on my setup and tell me what looks good and what I need to fix.');
    showTypingIndicator();
    const result = await window.wildtrade.chatSend('Run a full diagnostics check on my setup. Check all configured keys, models, trading mode, and recent logs. Tell me what looks good and what I need to fix.');
    removeTypingIndicator();
    if (result.error) {
      addChatMessage('bot', `<span style="color:#ef4444">${escapeHtml(result.error)}</span>`);
    } else {
      addChatMessage('bot', formatMarkdown(result.reply));
    }
  },

  async clearChat() {
    await window.wildtrade.chatClear();
    const container = document.getElementById('chat-messages');
    container.innerHTML = `<div class="chat-msg bot">
      <div class="chat-avatar">W</div>
      <div class="chat-bubble">Chat cleared. How can I help you?</div>
    </div>`;
  }
};

window.app = app;

// ── Chat helpers ──
function addChatMessage(role, html) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.innerHTML = `
    <div class="chat-avatar">${role === 'bot' ? 'W' : 'U'}</div>
    <div class="chat-bubble">${role === 'bot' ? html : escapeHtml(html)}</div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function showTypingIndicator() {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-msg bot';
  div.id = 'typing-indicator';
  div.innerHTML = `
    <div class="chat-avatar">W</div>
    <div class="chat-bubble typing"><span class="dot-1">.</span><span class="dot-2">.</span><span class="dot-3">.</span></div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function removeTypingIndicator() {
  const el = document.getElementById('typing-indicator');
  if (el) el.remove();
}

// Simple markdown-ish formatting for AI responses
function formatMarkdown(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n- /g, '\n• ')
    .replace(/\n\d+\. /g, (m) => '\n' + m.trim() + ' ')
    .replace(/\n/g, '<br>');
}


// ── Load settings into form ──
async function loadSettings() {
  const config = await window.wildtrade.loadConfig();

  CONFIG_FIELDS.forEach(key => {
    const el = document.getElementById(`cfg-${key}`);
    if (el && config[key] !== undefined) el.value = config[key];
  });

  TOGGLE_FIELDS.forEach(key => {
    const el = document.getElementById(`cfg-${key}`);
    if (el && config[key] !== undefined) el.checked = !!config[key];
  });

  updateDashboardFromConfig(config);
}

function updateDashboardFromConfig(config) {
  const paper = config.PAPER_TRADING !== false;
  const modeEl = document.getElementById('val-mode');
  modeEl.textContent = paper ? 'Paper Trading' : 'LIVE Trading';
  modeEl.style.color = paper ? '' : '#ef4444';
  document.getElementById('val-budget').textContent = `${config.TOTAL_BUDGET_SOL || '1.0'} SOL`;

  const finderModel = config.FINDER_MODEL || 'anthropic/claude-sonnet-4-5';
  const traderModel = config.TRADER_MODEL || 'openai/gpt-4o-mini';
  const auditorModel = config.AUDITOR_MODEL || 'openai/gpt-4o-mini';
  document.getElementById('agent-finder-model').textContent = finderModel.split('/').pop();
  document.getElementById('agent-trader-model').textContent = traderModel.split('/').pop();
  document.getElementById('agent-auditor-model').textContent = auditorModel.split('/').pop();
}

// ── Log rendering ──
function addLogEntry(entry) {
  const msg = typeof entry === 'string' ? entry : (entry.message || entry.msg || '');
  const level = typeof entry === 'string' ? 'info' : (entry.level || 'info');
  const time = typeof entry === 'string' ? Date.now() : (entry.time || Date.now());
  const logObj = { time, level, message: msg };
  logs.push(logObj);
  if (logs.length > 500) logs.shift();

  const line = createLogLine(logObj);

  const container = document.getElementById('log-container');
  container.appendChild(line.cloneNode(true));
  container.scrollTop = container.scrollHeight;

  const preview = document.getElementById('dashboard-logs');
  preview.appendChild(line);
  while (preview.children.length > 30) preview.removeChild(preview.firstChild);
  preview.scrollTop = preview.scrollHeight;
}

function createLogLine(entry) {
  const div = document.createElement('div');
  div.className = `log-line ${entry.level}`;
  const time = new Date(entry.time).toLocaleTimeString();
  div.innerHTML = `<span class="log-time">${time}</span>${escapeHtml(entry.message)}`;
  return div;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Bot status indicator ──
function setBotStatus(status) {
  const indicator = document.getElementById('bot-indicator');
  const btn = document.getElementById('btn-start');

  indicator.className = `indicator ${status}`;
  indicator.querySelector('.label').textContent =
    status === 'running' ? 'Running' :
    status === 'starting' ? 'Starting...' :
    status === 'stopping' ? 'Stopping...' :
    status === 'error' ? 'Error' : 'Stopped';

  botRunning = status === 'running' || status === 'starting';
  btn.textContent = botRunning ? 'Stop Bot' : 'Start Bot';
  btn.className = botRunning ? 'btn btn-start running' : 'btn btn-start';
}

// ── Event listeners (matching preload.cjs API) ──
window.wildtrade.onBotLog(entry => addLogEntry(entry));
window.wildtrade.onBotStatus(status => setBotStatus(status));
window.wildtrade.onBotError(msg => addLogEntry({ time: Date.now(), level: 'error', message: msg }));

// ── Proactive trade notifications in chat ──
window.wildtrade.onTradeUpdate(update => {
  const typeLabels = {
    smart_money_alert: 'Smart Money Alert',
    smart_money_update: 'Smart Money',
    signal_forwarded: 'Signal Sent to Trader',
    dca_entry: 'DCA Entry Executed',
    exit: 'Exit Triggered',
    position_opened: 'New Position',
    position_closed: 'Position Closed',
    safety_alert: 'Safety Warning',
    rugcheck_passed: 'RugCheck Passed',
    new_token_detected: 'New Token',
    token_scanned: 'Token Scanned',
    dexscreener_update: 'DexScreener',
  };

  const typeColors = {
    smart_money_alert: '#3b82f6',
    smart_money_update: '#3b82f6',
    signal_forwarded: '#10b981',
    dca_entry: '#10b981',
    exit: '#f59e0b',
    position_opened: '#10b981',
    position_closed: '#8b5cf6',
    safety_alert: '#ef4444',
    rugcheck_passed: '#10b981',
    new_token_detected: '#6366f1',
    token_scanned: '#8b949e',
    dexscreener_update: '#6366f1',
  };

  // Only show high-value notifications in chat (not every token scan)
  const chatWorthy = ['smart_money_alert', 'signal_forwarded', 'dca_entry', 'exit',
    'position_opened', 'position_closed', 'safety_alert'];
  if (!chatWorthy.includes(update.type)) return;

  const label = typeLabels[update.type] || 'Update';
  const color = typeColors[update.type] || '#8b949e';
  const msg = update.message || JSON.stringify(update);

  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-msg bot trade-notification';
  div.innerHTML = `
    <div class="chat-avatar" style="background:${color}">W</div>
    <div class="chat-bubble" style="border-left:3px solid ${color}">
      <strong style="color:${color}">[${label}]</strong><br>
      ${escapeHtml(msg)}
    </div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
});

// ── Init ──
(async () => {
  await loadSettings();
  const status = await window.wildtrade.getBotStatus();
  setBotStatus(status);

  const existingLogs = await window.wildtrade.getBotLogs();
  existingLogs.forEach(entry => addLogEntry(entry));
})();
