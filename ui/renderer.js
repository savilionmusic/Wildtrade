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
  sendChat() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    addChatMessage('user', text);
    handleChatCommand(text);
  },

  runDiagnostics() {
    addChatMessage('user', 'Run diagnostics');
    handleChatCommand('run diagnostics');
  }
};

window.app = app;

// ── Chat logic ──
function addChatMessage(role, text) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  const avatar = role === 'bot' ? 'W' : 'You';
  div.innerHTML = `
    <div class="chat-avatar">${role === 'bot' ? 'W' : 'U'}</div>
    <div class="chat-bubble">${role === 'bot' ? text : escapeHtml(text)}</div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

async function handleChatCommand(text) {
  const lower = text.toLowerCase();

  if (lower.includes('diagnostic') || lower.includes('check') || lower.includes('setup')) {
    const config = await window.wildtrade.loadConfig();
    const status = await window.wildtrade.getBotStatus();
    let report = '<strong>Diagnostics Report</strong><br><br>';

    // Check API key
    if (config.OPENROUTER_API_KEY && config.OPENROUTER_API_KEY.startsWith('sk-or-')) {
      report += '&#10003; OpenRouter API Key: Configured<br>';
    } else {
      report += '&#10007; OpenRouter API Key: <strong>Missing!</strong> Go to Settings and add it.<br>';
    }

    // Check wallet
    if (config.WALLET_PUBLIC_KEY && config.WALLET_PUBLIC_KEY !== '11111111111111111111111111111111') {
      report += '&#10003; Wallet Public Key: Configured<br>';
    } else {
      report += '&#9888; Wallet Public Key: Using default (paper trading only)<br>';
    }

    // Check RPC
    if (config.SOLANA_RPC_HELIUS && config.SOLANA_RPC_HELIUS.includes('helius')) {
      report += '&#10003; Helius RPC: Configured<br>';
    } else {
      report += '&#9888; Helius RPC: Not set (using public RPC, may be slow)<br>';
    }

    // Check models
    report += `<br><strong>Models</strong><br>`;
    report += `Finder: <code>${config.FINDER_MODEL || 'anthropic/claude-sonnet-4-5'}</code><br>`;
    report += `Trader: <code>${config.TRADER_MODEL || 'openai/gpt-4o-mini'}</code><br>`;
    report += `Auditor: <code>${config.AUDITOR_MODEL || 'openai/gpt-4o-mini'}</code><br>`;

    // Check trading mode
    report += `<br><strong>Trading</strong><br>`;
    report += `Mode: ${config.PAPER_TRADING !== false ? 'Paper Trading (safe)' : '<span style="color:#ef4444">LIVE TRADING</span>'}<br>`;
    report += `Budget: ${config.TOTAL_BUDGET_SOL || '1.0'} SOL<br>`;
    report += `Bot: ${status === 'running' ? 'Running' : 'Stopped'}<br>`;

    // Social
    report += `<br><strong>Social/Intel</strong><br>`;
    report += config.TWITTER_BEARER_TOKEN ? '&#10003; Twitter: Configured<br>' : '&#9888; Twitter: Not configured (optional)<br>';
    report += config.SMART_MONEY_WALLETS ? '&#10003; Smart Money Wallets: Configured<br>' : '&#9888; Smart Money Wallets: None set (optional)<br>';

    addChatMessage('bot', report);

  } else if (lower.includes('api key') || lower.includes('what do i need') || lower.includes('setup guide')) {
    addChatMessage('bot', `<strong>Setup Guide</strong><br><br>
      <strong>Required:</strong><br>
      1. <strong>OpenRouter API Key</strong> - Sign up at <code>openrouter.ai</code>, create an API key starting with <code>sk-or-</code><br><br>
      <strong>Recommended:</strong><br>
      2. <strong>Helius API Key</strong> - Free at <code>helius.dev</code> for whale tracking and faster RPC<br>
      3. <strong>Wallet Keys</strong> - Only needed for live trading. Paper mode works without them.<br><br>
      <strong>Optional:</strong><br>
      4. <strong>Twitter Bearer Token</strong> - For monitoring KOL mentions<br>
      5. <strong>Smart Money Wallets</strong> - Solana pubkeys you want to track<br><br>
      Go to the <strong>Settings</strong> tab to enter these. Click <strong>Save</strong> when done.`);

  } else if (lower.includes('portfolio') || lower.includes('position')) {
    if (!botRunning) {
      addChatMessage('bot', 'The bot is not running. Click <strong>Start Bot</strong> on the Dashboard first, then I can show portfolio data.');
    } else {
      addChatMessage('bot', 'Portfolio data is shown on the <strong>Dashboard</strong> tab. Check the cards at the top for budget, positions, and PnL.');
    }

  } else if (lower.includes('status') || lower.includes('health')) {
    const status = await window.wildtrade.getBotStatus();
    addChatMessage('bot', `Bot status: <strong>${status === 'running' ? 'Running' : status}</strong><br>
      Check the <strong>Dashboard</strong> for agent details and the <strong>Logs</strong> tab for any errors.`);

  } else if (lower.includes('start') || lower.includes('run')) {
    if (botRunning) {
      addChatMessage('bot', 'The bot is already running! Check the <strong>Dashboard</strong> and <strong>Logs</strong> tabs.');
    } else {
      addChatMessage('bot', 'Starting the bot for you...');
      await window.wildtrade.startBot();
    }

  } else if (lower.includes('stop')) {
    if (!botRunning) {
      addChatMessage('bot', 'The bot is already stopped.');
    } else {
      addChatMessage('bot', 'Stopping the bot...');
      await window.wildtrade.stopBot();
    }

  } else if (lower.includes('model') || lower.includes('which')) {
    addChatMessage('bot', `<strong>Model Recommendations</strong><br><br>
      <strong>Finder (Scout)</strong> - Needs strong reasoning:<br>
      &#8226; <code>anthropic/claude-sonnet-4-5</code> - Best balance of speed/quality<br>
      &#8226; <code>deepseek/deepseek-r1</code> - Cheap + strong reasoning<br><br>
      <strong>Trader (Executioner)</strong> - Needs speed + JSON parsing:<br>
      &#8226; <code>openai/gpt-4o-mini</code> - Fast and cheap (recommended)<br>
      &#8226; <code>anthropic/claude-3.5-haiku</code> - Good alternative<br><br>
      <strong>Auditor (Fixer)</strong> - Needs error analysis:<br>
      &#8226; <code>openai/gpt-4o-mini</code> - Fast and cheap (recommended)<br>
      &#8226; <code>deepseek/deepseek-chat</code> - Ultra cheap<br><br>
      Change these in the <strong>Settings</strong> tab using the dropdown menus.`);

  } else {
    addChatMessage('bot', `I can help with:<br>
      &#8226; <strong>"Run diagnostics"</strong> - Check your setup<br>
      &#8226; <strong>"What API keys do I need?"</strong> - Setup guide<br>
      &#8226; <strong>"Show portfolio"</strong> - Position info<br>
      &#8226; <strong>"What's the status?"</strong> - Bot health<br>
      &#8226; <strong>"Start the bot"</strong> / <strong>"Stop the bot"</strong><br>
      &#8226; <strong>"Which models should I use?"</strong> - Recommendations`);
  }
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

// ── Init ──
(async () => {
  await loadSettings();
  const status = await window.wildtrade.getBotStatus();
  setBotStatus(status);

  const existingLogs = await window.wildtrade.getBotLogs();
  existingLogs.forEach(entry => addLogEntry(entry));
})();
