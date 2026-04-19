# Obsidian Copilot

A plugin that embeds the **GitHub Copilot CLI** as a fully interactive terminal inside Obsidian, with automatic file context injection.

> ⚠️ **Windows only** for now (ConPTY + node-pty prebuilds).

## Features

- 🤖 **One-click Copilot** — Opens the Copilot CLI directly in any pane (sidebar, tab, split, bottom)
- 📂 **Auto file context** — Automatically prepends `@active-file` to your messages so Copilot knows what you're looking at
- ✂️ **Selection awareness** — If you have text selected, includes line numbers in the context
- 🎨 **Theme sync** — Terminal colors match your Obsidian theme (light/dark, custom themes) and update live
- 📐 **Proper resize** — Real PTY via node-pty relay, correct reflow on resize
- 🔗 **Clickable links** — URLs in terminal output are clickable
- ⚙️ **Configurable** — CLI flags, placement, working directory, auto-open, context injection toggle

## Commands

| Command | Description |
|---------|-------------|
| Open Copilot | Open in default placement |
| Open Copilot (right/left/bottom/tab/split) | Open in specific location |
| Toggle focus | Switch between editor and Copilot |
| Restart Copilot session | Kill and restart the process |
| Add current file as context | Manually type `@file` into terminal |
| Add selection as context | Type `@file` + selection info |

## Prerequisites

1. **GitHub Copilot CLI** installed and authenticated (`copilot` in PATH)
2. **Node.js** v18+ in PATH (used to run the PTY relay)
3. **Windows 10/11** (ConPTY support required)

## Installation

### Via BRAT (recommended)

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat)
2. Add this repo: `sebastienlevert/obsidian-copilot`
3. Enable the plugin
4. Run the setup command (see below)

### Manual

1. Download the latest release from [Releases](https://github.com/sebastienlevert/obsidian-copilot/releases)
2. Extract into your vault's `.obsidian/plugins/obsidian-copilot/`
3. Run the setup script:
   ```powershell
   cd .obsidian\plugins\obsidian-copilot
   node setup.js
   ```
4. Enable "Copilot" in Settings → Community Plugins

### Setup Script

The `setup.js` script installs the required `node-pty` native module for your system Node.js:

```powershell
node setup.js
```

This only needs to run once (or after Node.js major version upgrades).

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Default placement | Right sidebar | Where Copilot opens |
| Auto-open on vault load | On | Open Copilot when Obsidian starts |
| Copilot CLI flags | `--yolo --banner` | Flags passed to the CLI |
| Working directory | vault | CWD for the Copilot session |
| Auto-inject file context | On | Prepend @file to every message |

## Architecture

```
┌─────────────────────────────────────────────┐
│  Obsidian (Electron renderer)               │
│  ┌───────────────────────────────────────┐  │
│  │  CopilotView                          │  │
│  │  ├─ xterm.js (terminal rendering)     │  │
│  │  ├─ Input interception (context)      │  │
│  │  └─ child_process.spawn(node relay)   │  │
│  └───────────────┬───────────────────────┘  │
└──────────────────┼──────────────────────────┘
                   ↕ stdin/stdout pipes
┌──────────────────┼──────────────────────────┐
│  pty-relay.js (system Node.js process)      │
│  └─ node-pty → ConPTY → copilot CLI        │
└─────────────────────────────────────────────┘
```

The relay pattern is needed because Obsidian's Electron renderer blocks `worker_threads`, which node-pty requires for ConPTY's conout socket draining.

## Development

```bash
npm install
npm run build
# Copy main.js, manifest.json, styles.css, pty-relay.js to plugin folder
```

## License

MIT © Sébastien Levert
