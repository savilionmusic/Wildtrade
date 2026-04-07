// ── Settings field keys ──
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

// ── App API ──
const app = {
  async toggleBot() {
    const btn = document.getElementById('btn-start');
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

    // Show toast
    const toast = document.getElementById('save-toast');
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 2000);
  },

  clearLogs() {
    logs = [];
    document.getElementById('log-container').innerHTML = '';
    document.getElementById('dashboard-logs').innerHTML = '';
  }
};

window.app = app;

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

// ── Event listeners (matching preload.js API) ──
window.wildtrade.onBotLog(entry => addLogEntry(entry));
window.wildtrade.onBotStatus(status => setBotStatus(status));
window.wildtrade.onBotError(msg => addLogEntry({ time: Date.now(), level: 'error', message: msg }));

// ── Init ──
(async () => {
  await loadSettings();
  const status = await window.wildtrade.getBotStatus();
  setBotStatus(status);

  // Load any existing logs
  const existingLogs = await window.wildtrade.getBotLogs();
  existingLogs.forEach(entry => addLogEntry(entry));
})();
