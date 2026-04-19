# Obsidian Copilot

A minimal Obsidian plugin that embeds the **GitHub Copilot CLI** in a terminal panel, powered by [xterm.js](https://xtermjs.org/) and [node-pty](https://github.com/microsoft/node-pty).

## Features

- 🤖 **One-click Copilot** — Opens the Copilot CLI directly in a right sidebar panel
- 📐 **Proper resize** — Terminal redraws correctly when you resize or move the panel (real PTY via node-pty)
- 🎨 **WebGL rendering** — GPU-accelerated terminal rendering with canvas fallback
- 🔗 **Clickable links** — URLs in the terminal output are clickable
- ♻️ **Restart** — Press any key after Copilot exits, or use the "Restart Copilot" command
- 📂 **Vault context** — Copilot starts in your vault root directory

## Commands

| Command | Description |
|---------|-------------|
| `Open Copilot` | Open or reveal the Copilot panel in the right sidebar |
| `Restart Copilot session` | Kill and restart the current Copilot process |
| `Open Copilot in new pane` | Open a second Copilot instance |

## Prerequisites

1. **GitHub Copilot CLI** installed and in your PATH
2. **Node.js** build tools for your platform (needed for node-pty native compilation)
   - Windows: Visual Studio Build Tools with C++ workload
   - macOS: Xcode Command Line Tools
   - Linux: `build-essential` package

## Development

```bash
# Install dependencies
npm install

# Rebuild node-pty for Obsidian's Electron version
npm run rebuild-pty

# Build the plugin
npm run build

# Watch mode for development
npm run dev
```

## Installation (manual)

1. Build the plugin (see above)
2. Copy these files into your vault's `.obsidian/plugins/obsidian-copilot/`:
   - `main.js`
   - `manifest.json`
   - `styles.css`
   - `node_modules/node-pty/` (the native module)
3. Enable "Copilot" in Obsidian's Community Plugins settings

## Architecture

```
┌─────────────────────────────────────────┐
│  Obsidian                               │
│  ┌───────────────────────────────────┐  │
│  │  CopilotView (ItemView)           │  │
│  │  ┌─────────────────────────────┐  │  │
│  │  │  xterm.js + FitAddon        │◄─┼──┼── ResizeObserver
│  │  │  (terminal rendering)       │  │  │
│  │  └─────────┬───────────────────┘  │  │
│  │            ↕ data                 │  │
│  │  ┌─────────┴───────────────────┐  │  │
│  │  │  node-pty (real PTY)        │  │  │
│  │  │  ├─ ConPTY (Windows)        │  │  │
│  │  │  └─ pty.fork (macOS/Linux)  │  │  │
│  │  └─────────┬───────────────────┘  │  │
│  └────────────┼──────────────────────┘  │
└───────────────┼─────────────────────────┘
                ↕
        ┌───────┴────────┐
        │  copilot CLI   │
        │  (CWD = vault) │
        └────────────────┘
```

## License

MIT © Sébastien Levert
