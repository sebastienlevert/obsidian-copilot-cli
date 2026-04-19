# Copilot CLI

An Obsidian plugin that embeds **GitHub Copilot CLI** as a fully interactive terminal, powered by a lightweight Rust ConPTY bridge.

> **Windows only** — requires Windows 10/11 (ConPTY support).

## Features

- **One-click Copilot** — Opens the Copilot CLI directly in any pane (sidebar, tab, split, bottom).
- **File context awareness** — Writes the active file path to a `.context` file that Copilot reads via instructions, so it always knows what you're working on.
- **Theme sync** — Terminal colors match your Obsidian theme (light/dark, custom themes) and update live.
- **Proper resize** — Real PTY via ConPTY bridge with correct terminal reflow.
- **Clickable links** — URLs in terminal output are clickable.
- **Configurable** — CLI flags, placement, working directory, auto-open toggle.
- **Tiny footprint** — The ConPTY bridge is ~170KB (no Node.js native modules needed).

## Commands

| Command | Description |
|---------|-------------|
| Open Copilot | Open in default placement |
| Open Copilot (right/left/bottom/tab/split) | Open in specific location |
| Toggle focus to/from Copilot | Switch between editor and Copilot |
| Restart Copilot session | Kill and restart the process |
| Add current file as context | Type `@file` into terminal |
| Add selection as context | Type `@file` + selection into terminal |

## Prerequisites

1. **GitHub Copilot CLI** installed and authenticated (`copilot` in PATH).
2. **Windows 10/11** (ConPTY support required).

## Installation

### Via BRAT (recommended for beta testing)

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat).
2. In BRAT settings, click "Add Beta plugin".
3. Enter: `sebastienlevert/obsidian-copilot-cli`
4. Enable the plugin in Settings > Community Plugins.

> On first launch, the plugin will automatically download the `conpty-bridge.exe` binary (~170KB) from the latest GitHub release if it is not already present.

### Manual

1. Download the latest release zip from [GitHub Releases](https://github.com/sebastienlevert/obsidian-copilot/releases/latest).
2. Extract into your vault's `.obsidian/plugins/copilot-cli/`.
3. Enable "Copilot CLI" in Settings > Community Plugins.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Default placement | Right sidebar | Where Copilot opens |
| Auto-open on vault load | On | Open Copilot when Obsidian starts |
| Copilot CLI flags | `--yolo --banner` | Flags passed to the CLI |
| Working directory | vault | CWD for the Copilot session |
| Auto-inject file context | On | Write active file to `.context` for Copilot |

## Architecture

```
Obsidian (Electron renderer)
  CopilotView
  +-- xterm.js (terminal rendering)
  +-- .context file writer (active file tracking)
  +-- child_process.spawn(conpty-bridge.exe)
          |
          v  stdin/stdout pipes
  conpty-bridge.exe (170KB Rust binary)
  +-- Windows ConPTY (CreatePseudoConsole)
  +-- copilot CLI (or any shell command)
```

The ConPTY bridge creates a real pseudo-terminal using Windows native APIs. No Node.js native modules (like node-pty) are needed, eliminating ABI compatibility issues across Electron versions.

## Network Usage

This plugin makes network requests in the following cases:

- **ConPTY bridge download** — On first install via BRAT (or if the binary is missing), the plugin downloads `conpty-bridge.exe` (~170KB) from this repository's GitHub Releases. This is a one-time download.
- **GitHub Copilot CLI** — The Copilot CLI itself connects to GitHub's API to process your prompts. This is managed by the Copilot CLI, not the plugin.

The plugin itself does not collect telemetry or send data to any third-party service.

## Development

```bash
# Install dependencies
npm install

# Build the plugin
npm run build

# Build the ConPTY bridge (requires Rust)
cd conpty-bridge && cargo build --release

# Deploy to vault
cp main.js manifest.json styles.css conpty-bridge/target/release/conpty-bridge.exe \
   /path/to/vault/.obsidian/plugins/copilot-terminal/
```

## Credits

The ConPTY bridge is based on code from [obsidian-ai-terminal](https://github.com/Deok-ho/obsidian-ai-terminal) by Deok-ho, licensed under MIT.

## License

MIT - Sébastien Levert
