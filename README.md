# Wildtrade

Tri-Squad Multi-Agent Solana Trading Bot for the 1-to-10 SOL Challenge. Built on ElizaOS with three specialized AI agents: Scout (Finder), Executioner (Trader), and Fixer (Auditor).

## Quick Start (Desktop App)

### Prerequisites
- [Node.js](https://nodejs.org/) v18+ (for building)
- [Git](https://git-scm.com/)

### Install & Run

```bash
git clone https://github.com/savilionmusic/Wildtrade.git
cd Wildtrade
npm install
npm run electron:dev
```

The app will open with a GUI. Go to **Settings** and enter your API keys (at minimum an **OpenRouter API key**), then click **Start Bot**.

### Build Desktop App (Mac)

```bash
npm run build:mac
```

The `.app` will be in `release/`. Double-click to launch — no terminal needed.

### Build for Other Platforms

```bash
npm run build:win    # Windows
npm run build:linux  # Linux
```

## Settings (entered in the app)

| Setting | Required | Description |
|---------|----------|-------------|
| OpenRouter API Key | Yes | LLM provider (openrouter.ai) |
| Wallet Public Key | No | Your Solana pubkey |
| Wallet Private Key | No | Only for live trading |
| Helius API Key | No | Whale tracking (helius.dev) |
| Twitter Bearer Token | No | KOL monitoring on X |

## Architecture

Three agents share a database and communicate via ElizaOS rooms:

- **Scout (Finder)** - Scans Pump.fun, whale wallets, and KOL tweets for alpha signals
- **Executioner (Trader)** - DCA entries, tiered exits, portfolio scaling via Jupiter V6
- **Fixer (Auditor)** - Self-healing: RPC rotation, error recovery, honeypot detection

## Development (CLI mode)

```bash
# Install Bun (optional, for CLI dev)
curl -fsSL https://bun.sh/install | bash

cp .env.example .env
# Edit .env with your keys
bun run dev
```

## Project Structure

```
src/              Main entrypoint + agents
electron/         Electron desktop app wrapper
ui/               Dashboard + Settings UI
packages/
  shared/         Types, constants, database
  plugin-alpha-scout/    Finder agent plugin
  plugin-smart-trader/   Trader agent plugin
  plugin-self-healer/    Auditor agent plugin
characters/       Agent character JSON configs
build/            App icon assets
```
