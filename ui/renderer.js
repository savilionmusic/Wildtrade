// ── Settings field keys (inputs + selects) ──
const CONFIG_FIELDS = [
  'OPENROUTER_API_KEY', 'FINDER_MODEL', 'TRADER_MODEL', 'AUDITOR_MODEL',
  'WALLET_PUBLIC_KEY', 'WALLET_PRIVATE_KEY',
  'SOLANA_RPC_HELIUS', 'HELIUS_API_KEY', 'SOLANA_RPC_QUICKNODE',
  'MAX_POSITION_SIZE_SOL', 'TOTAL_BUDGET_SOL', 'MIN_SCORE_THRESHOLD',
  'JUPITER_SLIPPAGE_BPS', 'RUGCHECK_MIN_SCORE',
  'TWITTER_USERNAME', 'TWITTER_PASSWORD', 'TWITTER_EMAIL', 'TWITTER_TOKEN', 'TWITTER_COOKIES', 'TWITTER_API_BASE',
  'TWITTER_AUTO_KOL_DISCOVERY', 'TWITTER_DISCOVERY_KEYWORDS', 'TWITTER_MIN_FOLLOWERS', 'TWITTER_MAX_DISCOVERED_HANDLES',
  'TWITTER_BEARER_TOKEN', 'TWITTER_KOL_USER_IDS', 'TWITTER_POLL_INTERVAL_MS',
  'REDDIT_SUBREDDITS', 'REDDIT_POLL_INTERVAL_MS',
  'SMART_MONEY_WALLETS',
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
let portfolioInterval = null;

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

// Simple markdown-ish formatting for AI responses — also linkifies token addresses
function formatMarkdown(text) {
  let html = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n- /g, '\n• ')
    .replace(/\n\d+\. /g, (m) => '\n' + m.trim() + ' ')
    .replace(/\n/g, '<br>');

  // Linkify Solana addresses (32-44 base58 chars) → DexScreener
  html = html.replace(/\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g, (match) => {
    // Only link if it looks like a real token mint (not a UUID or short word)
    if (match.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(match)) {
      const short = match.slice(0, 6) + '...' + match.slice(-4);
      return `<a href="https://dexscreener.com/solana/${match}" target="_blank" class="token-link" title="${match}">${short}</a>`;
    }
    return match;
  });

  // Linkify explicit URLs
  html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" class="ext-link">$1</a>');

  return html;
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

  // Linkify Solana addresses in alert text
  const alertText = linkifyAlertText(alert.message);

  div.innerHTML = `
    <div class="alert-icon ${alert.category}">${icon}</div>
    <div class="alert-body">
      <div class="alert-type ${alert.category}">${typeLabel}</div>
      <div class="alert-text">${alertText}</div>
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

    // Linkify Solana addresses + URLs
    const linkified = linkifyAlertText(alert.message);

    // Extract mint address for Buy button if this is a signal
    const mintMatch = alert.message.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
    const mint = mintMatch ? mintMatch[1] : null;
    const symbolMatch = alert.message.match(/^(?:SIGNAL FORWARDED|ENTERING|CONVERGENCE):\s*(\S+)/i);
    const symbol = symbolMatch ? symbolMatch[1] : '';
    const showBuyBtn = mint && (alert.type === 'signal_forwarded' || alert.type === 'smart_money_cluster');
    const mintShort = mint ? mint.slice(0,8) : '';

    div.innerHTML = `
      <div class="alert-icon ${alert.category}">${icon}</div>
      <div class="alert-body">
        <div class="alert-type ${alert.category}">${typeLabel}</div>
        <div class="alert-text">${linkified}</div>
        ${showBuyBtn ? `
        <div class="alert-actions">
          <input type="number" id="sol-input-${mintShort}" class="alert-sol-input" value="0.1" step="0.05" min="0.01" max="5" title="SOL amount">
          <button class="alert-btn-buy" onclick="app.buyFromAlert('${mint}','${escapeHtml(symbol)}')">Buy</button>
          <button class="alert-btn-pass" onclick="this.closest('.alert-item').style.opacity='0.4'">Pass</button>
        </div>` : ''}
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

// Linkify Solana addresses → DexScreener links, and URLs → clickable
function linkifyAlertText(text) {
  let html = escapeHtml(text);
  // Linkify full URLs first
  html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" class="ext-link">$1</a>');
  // Linkify Solana addresses (32-44 base58 chars) that aren't already inside links
  html = html.replace(/(?<!href="[^"]*)\b([1-9A-HJ-NP-Za-km-z]{32,44})\b(?![^<]*<\/a>)/g, (match) => {
    if (match.length >= 32) {
      const short = match.slice(0, 6) + '...' + match.slice(-4);
      return `<a href="https://dexscreener.com/solana/${match}" target="_blank" class="token-link" title="${match}">${short}</a>`;
    }
    return match;
  });
  return html;
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
// Only show: potential buys (signals), actual trades, and safety warnings
const ACTIONABLE_TYPES = new Set([
  'signal_forwarded',
  'dca_entry', 'exit', 'position_opened', 'position_closed',
  'safety_alert', 'smart_money_cluster',
]);

// Deduplicate alerts — same message within 10s = skip
const recentAlertHashes = new Map(); // hash → timestamp

function isDuplicateAlert(msg) {
  const hash = msg.slice(0, 80);
  const now = Date.now();
  if (recentAlertHashes.has(hash) && now - recentAlertHashes.get(hash) < 10000) return true;
  recentAlertHashes.set(hash, now);
  // Cleanup old entries
  if (recentAlertHashes.size > 200) {
    for (const [k, v] of recentAlertHashes) {
      if (now - v > 30000) recentAlertHashes.delete(k);
    }
  }
  return false;
}

window.wildtrade.onTradeUpdate(update => {
  const type = update.type || 'alert';
  const msg = update.message || JSON.stringify(update);

  // Skip non-actionable spam (token scans, dex polls, wallet discovery)
  if (!ACTIONABLE_TYPES.has(type)) return;

  // Skip duplicates
  if (isDuplicateAlert(msg)) return;

  // Add to alerts panel
  addAlert(type, msg);

  // Push to chat
  const typeLabels = {
    smart_money_alert: 'Smart Money Alert', smart_money_cluster: 'Smart Money Cluster',
    signal_forwarded: 'Signal → Trader', dca_entry: 'DCA Entry',
    exit: 'Exit Triggered', position_opened: 'New Position',
    position_closed: 'Position Closed', safety_alert: 'Safety Warning',
    agent_action: 'Agent Action', kol_signal: 'KOL Signal',
  };
  const typeColors = {
    smart_money_alert: '#3b82f6', smart_money_cluster: '#3b82f6',
    signal_forwarded: '#10b981', dca_entry: '#10b981',
    exit: '#f59e0b', position_opened: '#10b981',
    position_closed: '#8b5cf6', safety_alert: '#ef4444',
    agent_action: '#f59e0b', kol_signal: '#a855f7',
  };

  const label = typeLabels[type] || 'Update';
  const color = typeColors[type] || '#8b949e';

  // Format message with DexScreener links for token addresses
  const formattedMsg = msg.replace(/\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g, (match) => {
    if (match.length >= 32) {
      const short = match.slice(0, 6) + '...' + match.slice(-4);
      return `<a href="https://dexscreener.com/solana/${match}" target="_blank" class="token-link" title="${match}">${short}</a>`;
    }
    return match;
  });

  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-msg bot trade-notification';

  // Extract mint address from message for buy button
  const mintMatch = msg.match(/\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/);
  const mintAddress = mintMatch ? mintMatch[1] : null;

  // Add buy button for potential buy signals
  let actionButtons = '';
  if (type === 'signal_forwarded' && mintAddress) {
    actionButtons = `
      <div style="margin-top:8px;display:flex;gap:6px">
        <button class="btn btn-start" style="padding:4px 12px;font-size:12px" onclick="app.quickBuy('${mintAddress}', 0.05)">Buy 0.05 SOL</button>
        <button class="btn btn-start" style="padding:4px 12px;font-size:12px" onclick="app.quickBuy('${mintAddress}', 0.1)">Buy 0.1 SOL</button>
        <input type="number" id="custom-sol-${mintAddress.slice(0,8)}" style="width:60px;padding:4px;background:#1a1f2e;border:1px solid #30363d;border-radius:4px;color:#c9d1d9;font-size:12px" value="0.05" step="0.01" min="0.01">
        <button class="btn btn-outline" style="padding:4px 8px;font-size:12px" onclick="app.quickBuy('${mintAddress}', parseFloat(document.getElementById('custom-sol-${mintAddress.slice(0,8)}').value))">Buy Custom</button>
      </div>`;
  }

  div.innerHTML = `
    <div class="chat-avatar" style="background:${color}">W</div>
    <div class="chat-bubble" style="border-left:3px solid ${color}">
      <strong style="color:${color}">[${label}]</strong><br>
      ${formattedMsg}
      ${actionButtons}
    </div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
});

// ── Bot logs → only alerts panel (not chat) for key events ──
window.wildtrade.onBotLog(entry => {
  addLogEntry(entry);

  // ONLY parse truly actionable log events into alerts (NO duplicates from IPC)
  const msg = typeof entry === 'string' ? entry : (entry.message || '');
  const lower = msg.toLowerCase();

  // Safety alerts from logs
  if (lower.includes('rugcheck') && lower.includes('failed')) {
    if (!isDuplicateAlert(msg)) addAlert('safety_alert', msg);
  }

  // Trader activity
  if (lower.includes('[trader]') && (lower.includes('entering position') || lower.includes('dca leg'))) {
    if (!isDuplicateAlert(msg)) addAlert('dca_entry', msg);
  }
  if (lower.includes('[trader]') && (lower.includes('exit tier') || lower.includes('stop loss'))) {
    if (!isDuplicateAlert(msg)) addAlert('exit', msg);
  }
  if (lower.includes('[trader]') && lower.includes('position closed')) {
    if (!isDuplicateAlert(msg)) addAlert('position_closed', msg);
  }

  // Convergence / smart money
  if (lower.includes('[convergence]') && lower.includes('convergence:')) {
    if (!isDuplicateAlert(msg)) addAlert('smart_money_cluster', msg);
  }

  // --- Alpha Intel Tab Parsers ---
  if (msg.includes('[META] Current Top Narratives:')) {
    const narrativesBox = document.getElementById('intel-narratives');
    if (narrativesBox) {
      narrativesBox.textContent = msg.split('[META] Current Top Narratives:')[1].trim();
    }
  }
  // Show KOL discovery progress in the narratives box as a fallback until real narratives arrive
  if (msg.includes('seeded KOL handles') || msg.includes('Auto-discovered') || msg.includes('KOL intelligence active')) {
    const narrativesBox = document.getElementById('intel-narratives');
    if (narrativesBox && narrativesBox.textContent.includes('Awaiting Scan...')) {
      narrativesBox.textContent = 'Scanning KOL timelines for trending Solana tokens...';
    }
  }
  if (msg.includes('[SCRAPER] X poll:') || msg.includes('OpenTwitter poll:')) {
    const narrativesBox = document.getElementById('intel-narratives');
    if (narrativesBox && narrativesBox.textContent === 'Scanning KOL timelines for trending Solana tokens...') {
      narrativesBox.textContent = 'Polling KOL tweets... No hot CA yet (need 2+ mentions to surface)';
    }
  }
  if (msg.includes('[alpha-scout] X/Twitter guest scraper ready') || msg.includes('Using X guest scraper') || msg.includes('twikit Python bridge') || msg.includes('Python Twitter bridge')) {
    const heatmapBox = document.getElementById('intel-heatmap');
    if (heatmapBox) heatmapBox.textContent = 'Python Twitter bridge active. Polling 20 KOL timelines every 2 min...';
  }
  if (msg.includes('Falling back to Nitter RSS') || msg.includes('Nitter RSS fallback active')) {
    const heatmapBox = document.getElementById('intel-heatmap');
    if (heatmapBox) heatmapBox.textContent = 'Twitter auth failed; using no-login Nitter RSS fallback for KOL signals.';
  }
  if (msg.includes('twikit not installed')) {
    const heatmapBox = document.getElementById('intel-heatmap');
    if (heatmapBox) heatmapBox.textContent = 'twikit not installed. Run in terminal: pip3 install twikit';
  }
  if (msg.includes('[twikit] Login successful')) {
    const heatmapBox = document.getElementById('intel-heatmap');
    if (heatmapBox) heatmapBox.textContent = 'Twitter logged in via twikit! Polling KOL timelines...';
  }
  if (msg.includes('[twikit] No Twitter credentials')) {
    const heatmapBox = document.getElementById('intel-heatmap');
    if (heatmapBox) heatmapBox.textContent = 'No Twitter credentials set. Add TWITTER_USERNAME + TWITTER_PASSWORD in Settings to enable KOL heatmap.';
  }
  if ((msg.includes('[twikit] Login failed') || msg.includes('Login failed:')) && !msg.includes('No Twitter credentials')) {
    const detail = msg.split('Login failed:')[1]?.trim().split('\n')[0] || '';
    const heatmapBox = document.getElementById('intel-heatmap');
    if (heatmapBox && !heatmapBox.textContent.includes('Nitter RSS fallback')) {
      heatmapBox.textContent = `Twitter login failed — retrying in 30 min.${detail ? '\nError: ' + detail.slice(0, 120) : '\nCheck credentials in Settings.'}`;
    }
  }
  if (msg.includes('[twikit] Login failed — pausing')) {
    const heatmapBox = document.getElementById('intel-heatmap');
    if (heatmapBox && !heatmapBox.textContent.includes('retrying in 30 min')) {
      heatmapBox.textContent = 'Twitter login failed — KOL polling paused 30 min. Check credentials in Settings.';
    }
  }
  if (msg.includes('[alpha-scout] Using Python Twitter bridge with')) {
    const heatmapBox = document.getElementById('intel-heatmap');
    if (heatmapBox) {
      if (heatmapBox.textContent.includes('Awaiting Intel...')) {
        heatmapBox.textContent = 'Python Twitter bridge active. Polling 20 KOL timelines every 2 min...';
      }
    }
  }
  if (msg.includes('[alpha-scout] WARNING: TWITTER_USERNAME')) {
    const heatmapBox = document.getElementById('intel-heatmap');
    if (heatmapBox) heatmapBox.textContent = 'No Twitter credentials found. Add them in Settings.';
  }
  if (msg.includes('[HEATMAP]')) {
    const heatmapBox = document.getElementById('intel-heatmap');
    if (heatmapBox) {
      const hit = msg.split('[HEATMAP]')[1].trim();
      let existing = heatmapBox.textContent.replace('Awaiting Intel...', '').trim();
      // keep last 5 trending tokens in heatmap box
      let lines = existing.split('\n').filter(Boolean);
      // if same token hits again, remove old entry so it jumps to top
      const tokenSymbol = hit.split('velocity')[0]; 
      lines = lines.filter(l => !l.includes(tokenSymbol));
      lines.unshift(hit);
      if (lines.length > 5) lines.pop();
      heatmapBox.textContent = lines.join('\n');
    }
  }
  if (msg.includes('Tracking top 20 wallets') || msg.includes('[social-scout] Tracking')) {
    const smartMoneyBox = document.getElementById('intel-smartmoney');
    if (smartMoneyBox && smartMoneyBox.textContent.includes('Tracking Wallets...')) {
      smartMoneyBox.textContent = "Monitoring 20 wallets & KOLs for early entries.";
    }
  }
  if (msg.includes('[smart-money] CLUSTER DETECTED:')) {
    const smartMoneyBox = document.getElementById('intel-smartmoney');
    if (smartMoneyBox) {
      const hit = msg.split('DETECTED:')[1].trim();
      let existing = smartMoneyBox.textContent.replace('Monitoring 20 wallets & KOLs for early entries.', '').replace('Tracking Wallets...', '').trim();
      let lines = existing.split('\n').filter(Boolean);
      // prevent exact duplicates
      lines = lines.filter(l => l !== hit);
      lines.unshift(hit);
      if (lines.length > 5) lines.pop();
      smartMoneyBox.textContent = lines.join('\n');
    }
  }

  // Add all intel signals to the Intel specific log viewer
  if (msg.includes('[HEATMAP]') || msg.includes('[AI NARRATIVE]') || msg.includes('[META]') ||
      msg.includes('[smart-money]') || msg.includes('CLUSTER DETECTED') ||
      msg.includes('[social-scout]') || msg.includes('[alpha-scout]') || msg.includes('[SCRAPER]') ||
      msg.includes('[kol-scraper]')) {
    const intelSignals = document.getElementById('intel-signals');
    if (intelSignals) {
      // remove the waiting message if it exists
      if (intelSignals.innerHTML.includes('Waiting for intel data...')) {
        intelSignals.innerHTML = '';
      }
      const entryDiv = document.createElement('div');
      entryDiv.style.marginBottom = '6px';
      entryDiv.style.borderBottom = '1px solid #333';
      entryDiv.style.paddingBottom = '4px';
      
      let color = '#ccc';
      if (msg.includes('[HEATMAP]')) color = '#ff9800';
      if (msg.includes('[AI NARRATIVE]') || msg.includes('[META]')) color = '#00e5ff';
      if (msg.includes('[smart-money]') || msg.includes('CLUSTER DETECTED')) color = '#00ff00';
      if (msg.includes('[social-scout]') || msg.includes('[alpha-scout]') || msg.includes('[SCRAPER]') || msg.includes('[kol-scraper]')) color = '#aaa';
      
      entryDiv.innerHTML = `<span style="color: #666">[${new Date().toLocaleTimeString()}]</span> <span style="color: ${color}">${msg}</span>`;
      intelSignals.prepend(entryDiv);
      
      // Cleanup old
      if (intelSignals.children.length > 200) {
        intelSignals.removeChild(intelSignals.lastChild);
      }
    }
  }
});

// ── Portfolio Tab ──
function refreshPortfolio() {
  if (!window.wildtrade.getPortfolio) return;
  window.wildtrade.getPortfolio().then(data => {
    if (!data) return;

    // Mode badge
    const mode = data.paper ? 'PAPER' : 'LIVE';
    document.getElementById('portfolio-mode').textContent = mode;
    document.getElementById('portfolio-mode').className = `mode-badge ${data.paper ? 'paper' : 'live'}`;

    // Phase badge
    const phaseEl = document.getElementById('portfolio-phase');
    if (phaseEl) phaseEl.textContent = data.phase || 'Phase 1';

    // ── Big PnL Hero ──
    const totalPnl = data.totalPnl ?? data.realized ?? 0;
    const totalPnlPct = data.totalPnlPct ?? 0;
    const isUp = totalPnl >= 0;
    const arrow = isUp ? '\u25B2' : '\u25BC';
    const sign = isUp ? '+' : '';
    const heroClass = totalPnl === 0 ? 'neutral' : (isUp ? 'up' : 'down');

    const heroEl = document.getElementById('pnl-hero');
    if (heroEl) heroEl.className = `pnl-hero ${heroClass}`;

    const heroVal = document.getElementById('pnl-hero-value');
    if (heroVal) heroVal.textContent = `${arrow} ${sign}${totalPnl.toFixed(4)} SOL`;

    const heroPct = document.getElementById('pnl-hero-pct');
    if (heroPct) heroPct.textContent = `${sign}${totalPnlPct.toFixed(2)}%`;

    // ── Stat cards ──
    const setEl = (id, txt) => { const e = document.getElementById(id); if (e) e.textContent = txt; };
    const setElColor = (id, txt, color) => { const e = document.getElementById(id); if (e) { e.textContent = txt; e.style.color = color; } };

    setEl('pf-value', `${(data.portfolioValue ?? data.budget).toFixed(4)} SOL`);
    setEl('pf-deployed', `${data.deployed} SOL`);
    setEl('pf-available', `${data.available} SOL`);
    setEl('pf-winrate', `${data.winRate}% (${data.trades} trades)`);
    setEl('pf-trades-today', `${data.tradesToday ?? 0} / ${data.maxTradesToday ?? 20}`);
    setEl('pf-target-mcap', data.targetMCap || '-');

    const realSign = (data.realized ?? 0) >= 0 ? '+' : '';
    const unrSign = (data.unrealized ?? 0) >= 0 ? '+' : '';
    setElColor('pf-realized', `${realSign}${(data.realized ?? 0).toFixed(4)} SOL`, (data.realized ?? 0) >= 0 ? 'var(--green)' : 'var(--red)');
    setElColor('pf-unrealized', `${unrSign}${(data.unrealized ?? 0).toFixed(4)} SOL`, (data.unrealized ?? 0) >= 0 ? 'var(--green)' : 'var(--red)');

    // Sync max positions dropdown with server value
    const maxPosSel = document.getElementById('max-positions-select');
    if (maxPosSel && data.maxPositions != null) {
      maxPosSel.value = String(data.maxPositions);
    }

    // Sync max trades/day dropdown with server value
    const maxTradesSel = document.getElementById('max-trades-day-select');
    if (maxTradesSel && data.maxTradesToday != null) {
      maxTradesSel.value = String(data.maxTradesToday);
    }

    // ── Dashboard cards ──
    document.getElementById('val-positions').textContent = data.positions.length;
    const dashPnl = document.getElementById('val-pnl');
    dashPnl.textContent = `${arrow} ${sign}${totalPnl.toFixed(4)} SOL`;
    dashPnl.style.color = isUp ? 'var(--green)' : 'var(--red)';

    const valBudget = document.getElementById('val-budget');
    if (valBudget && data.portfolioValue != null) {
      valBudget.textContent = `${data.portfolioValue.toFixed(4)} SOL`;
    }

    // ── Open positions with live PnL ──
    const posContainer = document.getElementById('positions-container');
    if (data.positions.length === 0) {
      posContainer.innerHTML = '<div class="positions-empty">No open positions. Bot scanning for qualifying signals...</div>';
    } else {
      posContainer.innerHTML = '';
      for (const p of data.positions) {
        const mult = p.currentPrice > 0 && p.entryPrice > 0 ? (p.currentPrice / p.entryPrice).toFixed(2) : '?';
        const pnlPct = p.pnlPct ?? 0;
        const pnlSol = p.pnlSol ?? 0;
        const posUp = pnlPct >= 0;
        const posArrow = posUp ? '\u25B2' : '\u25BC';
        const posColor = posUp ? 'var(--green)' : 'var(--red)';
        const posSign = posUp ? '+' : '';
        const div = document.createElement('div');
        div.className = 'position-row';
        div.innerHTML = `
          <div class="position-left">
            <span class="position-symbol"><a href="https://dexscreener.com/solana/${p.mintAddress}" target="_blank" class="token-link">${escapeHtml(p.symbol)}</a></span>
            <div style="font-size:11px; color:#aaa; margin-top:3px;">Reason: ${escapeHtml(p.reason || 'Scanner signal')}</div>
            <span class="position-size" style="margin-top:3px">${p.solDeployed.toFixed(4)} SOL | DCA ${p.dcaLegsExecuted}/3</span>
          </div>
          <div class="position-center">
            <span class="position-mult" style="color:${posColor}">${mult}x</span>
          </div>
          <div class="position-pnl" style="color:${posColor}">
            <span class="pnl-arrow">${posArrow}</span>
            <span class="pnl-pct">${posSign}${pnlPct.toFixed(1)}%</span>
            <span class="pnl-sol">${posSign}${pnlSol.toFixed(4)} SOL</span>
          </div>
          <div class="position-actions">
            <button class="btn-sell-half" onclick="app.sellPosition('${p.mintAddress}', 0.5)">Sell 50%</button>
            <button class="btn-sell-all" onclick="app.sellPosition('${p.mintAddress}', 1.0)">Sell All</button>
          </div>
        `;
        posContainer.appendChild(div);
      }
    }

    // ── Trade history ──
    const histContainer = document.getElementById('history-container');
    if (data.history.length === 0) {
      histContainer.innerHTML = '<div class="positions-empty">No trade history yet.</div>';
    } else {
      histContainer.innerHTML = '';
      for (const t of data.history.slice(-20).reverse()) {
        const pnlPct = t.pnlPct ?? 0;
        const isWin = pnlPct >= 0;
        const hArrow = isWin ? '\u25B2' : '\u25BC';
        const hSign = isWin ? '+' : '';
        const winClass = isWin ? 'win' : 'loss';
        const mins = Math.round((t.holdTimeMs || 0) / 60000);
        const div = document.createElement('div');
        div.className = 'history-row';
        div.innerHTML = `
          <span class="history-symbol">${escapeHtml(t.symbol)}</span>
          <span class="history-pnl ${winClass}">${hArrow} ${hSign}${pnlPct.toFixed(1)}%</span>
          <span class="history-meta">${mins}m held</span>
          <span class="history-meta">${escapeHtml(t.exitReason || '')}</span>
          <span class="history-meta">${escapeHtml(t.phase || '')}</span>
        `;
        histContainer.appendChild(div);
      }
    }

    // ── Lessons (Brain) ──
    const lessonsContainer = document.getElementById('lessons-container');
    const lessonsList = data.lessons || [];
    if (lessonsContainer) {
      if (lessonsList.length === 0) {
        lessonsContainer.innerHTML = '<div class="positions-empty">No lessons yet. I\'ll learn from every trade.</div>';
      } else {
        lessonsContainer.innerHTML = '';
        for (const l of lessonsList) {
          const conf = Math.round((l.confidence || 0) * 100);
          const icon = l.dimension === 'mcap' ? '\uD83C\uDFAF'
            : l.dimension === 'score' ? '\uD83D\uDCCA'
            : l.dimension === 'hold_time' ? '\u23F1\uFE0F'
            : l.dimension === 'dca' ? '\uD83D\uDCC8'
            : l.dimension === 'size' ? '\uD83D\uDCB0'
            : l.dimension === 'exits' ? '\uD83D\uDEA8'
            : '\uD83E\uDDE0';
          const div = document.createElement('div');
          div.className = 'lesson-row';
          div.innerHTML = `
            <span class="lesson-icon">${icon}</span>
            <span class="lesson-text">${escapeHtml(l.insight)}</span>
            <span class="lesson-conf">${conf}%</span>
          `;
          lessonsContainer.appendChild(div);
        }
      }
    }
  }).catch(() => {});
}

// Start portfolio refresh when on portfolio tab — refresh every 3s
document.querySelector('[data-tab="portfolio"]')?.addEventListener('click', () => {
  refreshPortfolio();
  if (!portfolioInterval) {
    portfolioInterval = setInterval(refreshPortfolio, 3000);
  }
});

// ── Set max positions from portfolio dropdown ──
app.setMaxPositions = function(val) {
  const n = parseInt(val, 10);
  if (n >= 1 && n <= 5 && window.wildtrade.setConfig) {
    window.wildtrade.setConfig('MAX_POSITIONS', n);
  }
};

// ── Set max trades per day from portfolio dropdown ──
app.setMaxTradesPerDay = function(val) {
  const n = parseInt(val, 10);
  if (n >= 1 && n <= 100 && window.wildtrade.setConfig) {
    window.wildtrade.setConfig('MAX_TRADES_PER_DAY', n);
  }
};

// ── Reset paper portfolio ──
app.resetPortfolio = async function() {
  if (!confirm('Reset portfolio back to 1 SOL? All positions and trade history will be cleared.')) return;
  if (window.wildtrade.resetPortfolio) {
    const result = await window.wildtrade.resetPortfolio();
    addChatMessage('bot', typeof result === 'string' ? result : 'Portfolio reset.');
    refreshPortfolio();
  }
};

// ── Sell position from portfolio ──
app.sellPosition = async function(mint, pct) {
  const result = await window.wildtrade.chatSend(`sell ${mint} ${pct * 100}%`);
  if (result.reply) {
    addChatMessage('bot', formatMarkdown(result.reply));
  }
  setTimeout(refreshPortfolio, 2000);
};

// ── Buy from alert ──
app.buyFromAlert = async function(mint, symbol) {
  const input = document.getElementById(`sol-input-${mint.slice(0,8)}`);
  const sol = input ? parseFloat(input.value) || 0.1 : 0.1;
  addChatMessage('bot', `Buying ${symbol || mint.slice(0,8)} with ${sol} SOL...`);
  const result = await window.wildtrade.chatSend(`buy ${mint} ${sol}`);
  if (result.reply) {
    addChatMessage('bot', formatMarkdown(result.reply));
  }
  setTimeout(refreshPortfolio, 2000);
};

app.quickBuy = async function(mint, sol) {
  const symbol = mint.slice(0,8);
  addChatMessage('user', `buy ${symbol} ${sol}`);
  addChatMessage('bot', `Executing buy order for ${sol} SOL...`);
  const result = await window.wildtrade.chatSend(`buy ${mint} ${sol}`);
  if (result.reply) {
    addChatMessage('bot', formatMarkdown(result.reply));
  }
  setTimeout(refreshPortfolio, 2000);
};

// ── Init ──
// Intercept all link clicks to open in system browser
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[href]');
  if (link && link.href && (link.href.startsWith('https://') || link.href.startsWith('http://'))) {
    e.preventDefault();
    if (window.wildtrade?.openExternal) {
      window.wildtrade.openExternal(link.href);
    }
  }
});

(async () => {
  await loadSettings();
  const status = await window.wildtrade.getBotStatus();
  setBotStatus(status);

  const existingLogs = await window.wildtrade.getBotLogs();
  existingLogs.forEach(entry => addLogEntry(entry));
})();
