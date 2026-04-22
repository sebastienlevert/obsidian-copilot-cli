# AGENTS.md — Copilot CLI Obsidian Plugin

This file provides context and instructions for AI coding agents working in this repository.

## Project Overview

An Obsidian plugin that embeds the GitHub Copilot CLI as an interactive xterm.js terminal inside Obsidian. It uses a Rust-based ConPTY bridge (`conpty-bridge.exe`) to connect a pseudo-terminal to the Copilot CLI process.

## Tech Stack

| Layer       | Technology                              |
| ----------- | --------------------------------------- |
| Plugin      | TypeScript, Obsidian API                |
| Terminal    | xterm.js (canvas renderer)              |
| PTY bridge  | Rust (`conpty-bridge/`) → ConPTY on Win |
| IDE server  | Node.js HTTP on named pipe (MCP JSON-RPC) |
| Bundler     | esbuild (`esbuild.config.mjs`)          |
| Package     | npm                                     |

## Repository Structure

```
src/
  main.ts              → Plugin entry point (commands, settings, view registration)
  CopilotView.ts       → Terminal view (xterm.js, PTY lifecycle, keyboard handling)
  CopilotSettingTab.ts  → Settings UI
  ContextProvider.ts    → IDE state collection (selection caching for IDE server)
  IdeServer.ts          → Native IDE server (HTTP on named pipe, /ide discovery)
  constants.ts         → Shared constants and types
  styles.css           → Terminal CSS (copied to root on build)
conpty-bridge/         → Rust ConPTY bridge binary source
.agents/skills/        → Agent skills (see below)
manifest.json          → Obsidian plugin manifest
esbuild.config.mjs     → Build configuration
```

## Building

```shell
npm run build     # Production build → main.js + styles.css
npm run dev       # Watch mode for development
```

The build produces `main.js` (bundled plugin) and copies `src/styles.css` to the root as `styles.css`. Both are listed in `.gitignore` because they are build artifacts.

## Skills

Skills are located in `.agents/skills/` and describe repeatable workflows the agent can execute.

### Deploy to Obsidian — `.agents/skills/deploy.md`

**Trigger phrases:** "deploy", "deploy to obsidian", "test in obsidian", "install locally", "push to vault", "reload"

Builds the plugin and copies `main.js`, `styles.css`, `manifest.json`, and optionally `conpty-bridge.exe` to the user's Obsidian vault plugin directory. Read `.agents/skills/deploy.md` for the full step-by-step procedure.

## Key Conventions

- **Keyboard events:** The terminal intercepts keyboard events at the document level (capture phase) to prevent Obsidian from stealing keystrokes. See `setupKeyboardInterception()` in `CopilotView.ts`.
- **Native IDE server:** The plugin runs an HTTP server on a named pipe (Windows) or Unix socket that implements the same MCP JSON-RPC protocol VS Code uses. A lock file at `~/.copilot/ide/<uuid>.lock` advertises the socket path, auth nonce, and workspace folders so Copilot CLI's `/ide` command can discover Obsidian. Tools: `get_vscode_info`, `get_selection`, `get_open_files`, `get_diagnostics`, `open_diff`, `close_diff`, `update_session_name`. Stale lock files are cleaned on startup by PID check. See `IdeServer.ts`.
- **Context provider:** `ContextProvider.ts` collects IDE state from the Obsidian API (active file, selection, open files, metadata) and caches selections across focus changes so the IDE server can report them even when the editor loses focus.
- **No node-pty:** The project avoids `node-pty` in favor of a standalone Rust binary (`conpty-bridge.exe`) to avoid native module issues in Electron/Obsidian.
- **Theme integration:** The xterm.js theme is derived from Obsidian CSS variables and updates automatically on theme changes.
- **Never overwrite `data.json`:** This file in the Obsidian plugin directory stores user settings and must not be touched during deployment.
