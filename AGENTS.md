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
| MCP server  | `@modelcontextprotocol/sdk` (stdio)     |
| Bundler     | esbuild (`esbuild.config.mjs`)          |
| Package     | npm                                     |

## Repository Structure

```
src/
  main.ts              → Plugin entry point (commands, settings, view registration)
  CopilotView.ts       → Terminal view (xterm.js, PTY lifecycle, keyboard handling)
  CopilotSettingTab.ts  → Settings UI
  ContextProvider.ts    → Proactive IDE context collection from Obsidian API
  ContextWriter.ts      → Debounced writer for copilot-instructions.md + state JSON
  McpRegistrar.ts       → Auto-registers MCP server in ~/.copilot/mcp-config.json
  constants.ts         → Shared constants and types
  styles.css           → Terminal CSS (copied to root on build)
  mcp-server/
    index.ts           → Standalone MCP server (ide_* tools for Copilot CLI)
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

The build produces `main.js` (bundled plugin), `obsidian-mcp-server.mjs` (standalone MCP server), and copies `src/styles.css` to the root as `styles.css`. All are listed in `.gitignore` because they are build artifacts.

## Skills

Skills are located in `.agents/skills/` and describe repeatable workflows the agent can execute.

### Deploy to Obsidian — `.agents/skills/deploy.md`

**Trigger phrases:** "deploy", "deploy to obsidian", "test in obsidian", "install locally", "push to vault", "reload"

Builds the plugin and copies `main.js`, `styles.css`, `manifest.json`, `obsidian-mcp-server.mjs`, and optionally `conpty-bridge.exe` to the user's Obsidian vault plugin directory. Read `.agents/skills/deploy.md` for the full step-by-step procedure.

## Key Conventions

- **Keyboard events:** The terminal intercepts keyboard events at the document level (capture phase) to prevent Obsidian from stealing keystrokes. See `setupKeyboardInterception()` in `CopilotView.ts`.
- **Proactive IDE context:** The plugin writes real-time IDE context (active file, open tabs, selection, vault structure, metadata) to `.github/copilot-instructions.md` in the vault root. Copilot CLI reads this file automatically on every conversation turn. The context is event-driven (file switch, tab change, selection change) with 500ms debouncing. See `ContextProvider.ts` and `ContextWriter.ts`.
- **MCP server:** The plugin ships `obsidian-mcp-server.mjs`, a standalone MCP server that Copilot CLI spawns as a subprocess. It exposes `ide_*` tools (`ide_get_selection`, `ide_get_open_files`, `ide_read_file`, `ide_get_diagnostics`, `ide_search_text`, `ide_list_dir`) so Copilot CLI treats Obsidian as a full IDE. Auto-registered in `~/.copilot/mcp-config.json` on plugin load. See `McpRegistrar.ts` and `src/mcp-server/index.ts`.
- **No node-pty:** The project avoids `node-pty` in favor of a standalone Rust binary (`conpty-bridge.exe`) to avoid native module issues in Electron/Obsidian.
- **Theme integration:** The xterm.js theme is derived from Obsidian CSS variables and updates automatically on theme changes.
- **Never overwrite `data.json`:** This file in the Obsidian plugin directory stores user settings and must not be touched during deployment.
