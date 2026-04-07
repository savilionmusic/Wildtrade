// ── Settings field keys (inputs + selects) ──
const CONFIG_FIELDS = [
  'OPENROUTER_API_KEY', 'FINDER_MODEL', 'TRADER_MODEL', 'AUDITOR_MODEL',
  'WALLET_PUBLIC_KEY', 'WALLET_PRIVATE_KEY',
  'SOLANA_RPC_HELIUS', 'HELIUS_API_KEY', 'SOLANA_RPC_QUICKNODE',
  'MAX_POSITION_SIZE_SOL', 'TOTAL_BUDGET_SOL', 'MIN_SCORE_THRESHOLD',
  'JUPITER_SLIPPAGE_BPS', 'RUGCHECK_MIN_SCORE',
  'TWITTER_BEARER_TOKEN', 'TWITTER_KOL_USER_IDS', 'SMART_MONEY_WALLETS',
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID',
];

const TOGGLE_FIELDS = ['PAPER_TRADING', 'AUTONOMOUS_MODE'];

// ── State ──
let botRunning = false;
let logs = [];
let alerts = [];
let alertsPaused = false;
let alertFilter = 'all';
let unseenAlerts = 0;

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
  },

  // ── Alerts ──
  clearAlerts() {
    alerts = [];
    unseenAlerts = 0;
    updateAlertBadge();
    renderAlerts();
  },

  toggleAlertPause() {
    alertsPaused = !alertsPaused;
    document.getElementById('alert-pause-text').textContent = alertsPaused ? 'Resume' : 'Pause';
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

// ── Alert filter handlers ──
document.querySelectorAll('.alert-filter').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.alert-filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    alertFilter = btn.dataset.filter;
    renderAlerts();
  });
});

// ── Alert system ──
const ALERT_ICONS = {
  smart_money: '\u{1F9E0}', scanner: '\u{1F50D}', kol: '\u{1F4E2}',
  trade: '\u{1F4B0}', safety: '\u{26A0}', system: '\u{2699}',
};

const ALERT_CATEGORIES = {
  smart_money_alert: 'smart_money', smart_money_cluster: 'smart_money', smart_money_update: 'smart_money',
  wallet_intel: 'smart_money',
  signal_forwarded: 'scanner', token_scanned: 'scanner', new_token_detected: 'scanner',
  dexscreener_update: 'scanner', scanner: 'scanner',
  kol_intel: 'kol', kol_signal: 'kol',
  dca_entry: 'trade', exit: 'trade', position_opened: 'trade', position_closed: 'trade',
  safety_alert: 'safety', rugcheck_passed: 'safety',
  agent_action: 'system', alert: 'system',
};

function addAlert(type, message) {
  if (alertsPaused) return;

  const category = ALERT_CATEGORIES[type] || 'system';
  const alert = { type, category, message, timestamp: Date.now() };
  alerts.unshift(alert); // newest first
  if (alerts.length > 500) alerts.pop();

  // Update badge if not on alerts tab
  const alertsTab = document.getElementById('tab-alerts');
  if (!alertsTab.classList.contains('active')) {
    unseenAlerts++;
    updateAlertBadge();
  }

  // Add to DOM if filter matches
  if (alertFilter === 'all' || alertFilter === category) {
    prependAlertItem(alert);
  }
}

function updateAlertBadge() {
  const badge = document.getElementById('alert-badge');
  if (unseenAlerts > 0) {
    badge.textContent = unseenAlerts > 99 ? '99+' : unseenAlerts;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function prependAlertItem(alert) {
  const container = document.getElementById('alerts-container');
  const empty = container.querySelector('.alert-empty');
  if (empty) empty.remove();

  const div = document.createElement('div');
  div.className = 'alert-item';
  div.dataset.category = alert.category;

  const icon = ALERT_ICONS[alert.category] || '\u{1F514}';
  const time = new Date(alert.timestamp).toLocaleTimeString();
  const typeLabel = alert.type.replace(/_/g, ' ').toUpperCase();

  div.innerHTML = `
    <div class="alert-icon ${alert.category}">${icon}</div>
    <div class="alert-body">
      <div class="alert-type ${alert.category}">${typeLabel}</div>
      <div class="alert-text">${escapeHtml(alert.message)}</div>
    </div>
    <div class="alert-time">${time}</div>
  `;
  container.prepend(div);

  // Keep max 200 DOM elements
  while (container.children.length > 200) container.lastChild.remove();
}

function renderAlerts() {
  const container = document.getElementById('alerts-container');
  container.innerHTML = '';

  const filtered = alertFilter === 'all' ? alerts : alerts.filter(a => a.category === alertFilter);

  if (filtered.length === 0) {
    container.innerHTML = '<div class="alert-empty">No alerts in this category.</div>';
    return;
  }

  for (const alert of filtered.slice(0, 200)) {
    const div = document.createElement('div');
    div.className = 'alert-item';

    const icon = ALERT_ICONS[alert.category] || '\u{1F514}';
    const time = new Date(alert.timestamp).toLocaleTimeString();
    const typeLabel = alert.type.replace(/_/g, ' ').toUpperCase();

    div.innerHTML = `
      <div class="alert-icon ${alert.category}">${icon}</div>
      <div class="alert-body">
        <div class="alert-type ${alert.category}">${typeLabel}</div>
        <div class="alert-text">${escapeHtml(alert.message)}</div>
      </div>
      <div class="alert-time">${time}</div>
    `;
    container.appendChild(div);
  }
}

// Clear unseen count when alerts tab is opened
document.querySelector('[data-tab="alerts"]').addEventListener('click', () => {
  unseenAlerts = 0;
  updateAlertBadge();
});


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

// ── Event listeners ──
window.wildtrade.onBotStatus(status => setBotStatus(status));
window.wildtrade.onBotError(msg => addLogEntry({ time: Date.now(), level: 'error', message: msg }));

// ── Proactive trade notifications → alerts + chat ──
window.wildtrade.onTradeUpdate(update => {
  const type = update.type || 'alert';
  const msg = update.message || JSON.stringify(update);

  // ALWAYS add to alerts panel
  addAlert(type, msg);

  // Also add high-value alerts to chat
  const chatWorthy = ['smart_money_alert', 'smart_money_cluster', 'signal_forwarded', 'dca_entry', 'exit',
    'position_opened', 'position_closed', 'safety_alert', 'agent_action'];
  if (!chatWorthy.includes(type)) return;

  const typeLabels = {
    smart_money_alert: 'Smart Money Alert', smart_money_cluster: 'Smart Money Cluster',
    signal_forwarded: 'Signal Sent to Trader', dca_entry: 'DCA Entry',
    exit: 'Exit Triggered', position_opened: 'New Position',
    position_closed: 'Position Closed', safety_alert: 'Safety Warning',
    agent_action: 'Agent Action',
  };
  const typeColors = {
    smart_money_alert: '#3b82f6', smart_money_cluster: '#3b82f6',
    signal_forwarded: '#10b981', dca_entry: '#10b981',
    exit: '#f59e0b', position_opened: '#10b981',
    position_closed: '#8b5cf6', safety_alert: '#ef4444',
    agent_action: '#f59e0b',
  };

  const label = typeLabels[type] || 'Update';
  const color = typeColors[type] || '#8b949e';

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

// ── Also feed bot logs into alerts for key events ──
window.wildtrade.onBotLog(entry => {
  addLogEntry(entry);

  // Parse important log lines into alerts
  const msg = typeof entry === 'string' ? entry : (entry.message || '');
  const lower = msg.toLowerCase();

  if (lower.includes('[scanner]') && lower.includes('scanned:')) {
    addAlert('token_scanned', msg.replace(/.*\[scanner\]\s*/i, ''));
  }
  if (lower.includes('[scanner]') && lower.includes('signal forwarded')) {
    addAlert('signal_forwarded', msg.replace(/.*\[scanner\]\s*/i, ''));
  }
  if (lower.includes('[smart-money]') && lower.includes('cluster')) {
    addAlert('smart_money_cluster', msg.replace(/.*\[smart-money\]\s*/i, ''));
  }
  if (lower.includes('[wallet-intel]') && lower.includes('discovered')) {
    addAlert('wallet_intel', msg.replace(/.*\[wallet-intel\]\s*/i, ''));
  }
  if (lower.includes('[kol-intel]') && lower.includes('found')) {
    addAlert('kol_intel', msg.replace(/.*\[kol-intel\]\s*/i, ''));
  }
  if (lower.includes('rugcheck') && lower.includes('failed')) {
    addAlert('safety_alert', msg);
  }
  if (lower.includes('[alpha-scout]') && lower.includes('new token from pumpportal')) {
    addAlert('new_token_detected', msg.replace(/.*\[alpha-scout\]\s*/i, ''));
  }
  if (lower.includes('dexscreener') && (lower.includes('profiles:') || lower.includes('boosts:'))) {
    addAlert('dexscreener_update', msg.replace(/.*\[scanner\]\s*/i, ''));
  }
});

// ── Init ──
(async () => {
  await loadSettings();
  const status = await window.wildtrade.getBotStatus();
  setBotStatus(status);

  const existingLogs = await window.wildtrade.getBotLogs();
  existingLogs.forEach(entry => addLogEntry(entry));
})();
