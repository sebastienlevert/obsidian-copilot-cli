import { ItemView, WorkspaceLeaf } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";

import { VIEW_TYPE_COPILOT } from "./constants";
import type CopilotPlugin from "./main";

// xterm.js CSS (injected at runtime)
import xtermCss from "@xterm/xterm/css/xterm.css";

import { ChildProcess } from "child_process";

export class CopilotView extends ItemView {
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private childProc: ChildProcess | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private styleEl: HTMLStyleElement | null = null;
  private restartPending = false;
  private plugin: CopilotPlugin;
  private inputBuffer = "";  // tracks current line for context injection
  private lastActiveFile: string | null = null;  // cached active file path
  private lastSelection: string | null = null;   // cached selection info
  private activeFileWatcher: any = null;
  private themeMutationObserver: MutationObserver | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: CopilotPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_COPILOT;
  }

  getDisplayText(): string {
    return "Copilot";
  }

  getIcon(): string {
    return "copilot-icon";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("copilot-terminal-container");

    // Inject xterm CSS into the document
    this.styleEl = document.createElement("style");
    this.styleEl.textContent = xtermCss;
    document.head.appendChild(this.styleEl);

    // Terminal wrapper fills the view
    const wrapper = container.createDiv({ cls: "copilot-terminal-wrapper" });

    // Initialize xterm.js — theme reads from Obsidian CSS variables
    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'Cascadia Code', 'Fira Code', Consolas, 'Courier New', monospace",
      theme: this.getObsidianTheme(),
      allowProposedApi: true,
      scrollback: 10000,
    });

    // Addons
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon());

    // Canvas renderer is used (WebGL requires Workers which Obsidian doesn't support)

    this.terminal.open(wrapper);

    // Watch for Obsidian theme changes (light/dark toggle, theme switch)
    this.themeMutationObserver = new MutationObserver(() => {
      if (this.terminal) {
        this.terminal.options.theme = this.getObsidianTheme();
      }
    });
    this.themeMutationObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    // Delay fit to allow DOM layout to settle, then spawn
    requestAnimationFrame(() => {
      this.fitAddon?.fit();
      this.spawnCopilot();
    });

    // Resize observer - refit terminal and notify PTY on container resize
    this.resizeObserver = new ResizeObserver(() => {
      this.handleResize();
    });
    this.resizeObserver.observe(wrapper);

    // Watch active file/selection changes — cache them so they're available
    // even after focus moves to the terminal
    this.activeFileWatcher = this.app.workspace.on("active-leaf-change", () => {
      this.cacheEditorContext();
    });
    // Also watch for selection changes via editor-change event
    this.registerEvent(
      this.app.workspace.on("editor-change" as any, () => {
        this.cacheEditorContext();
      })
    );
    // Initial capture
    this.cacheEditorContext();
  }

  /** Build xterm theme from Obsidian's CSS variables — adapts to any theme */
  private getObsidianTheme(): Record<string, string> {
    const style = getComputedStyle(document.body);
    const get = (v: string) => style.getPropertyValue(v).trim();
    const isDark = document.body.classList.contains("theme-dark");

    // Pull colors from Obsidian CSS vars where possible, fallback to sensible defaults
    const bg = get("--background-primary") || (isDark ? "#1e1e1e" : "#ffffff");
    const fg = get("--text-normal") || (isDark ? "#dcddde" : "#383a42");
    const muted = get("--text-muted") || (isDark ? "#999999" : "#6a6a6a");
    const accent = get("--interactive-accent") || (isDark ? "#7289da" : "#4078f2");
    const selBg = get("--text-selection") || (isDark ? "#264f78" : "#bfceff");

    return {
      background: bg,
      foreground: fg,
      cursor: accent,
      selectionBackground: selBg,
      black: isDark ? "#1e1e1e" : "#383a42",
      red: get("--color-red") || (isDark ? "#f44747" : "#e45649"),
      green: get("--color-green") || (isDark ? "#6a9955" : "#50a14f"),
      yellow: get("--color-yellow") || (isDark ? "#d7ba7d" : "#c18401"),
      blue: get("--color-blue") || (isDark ? "#569cd6" : "#4078f2"),
      magenta: get("--color-purple") || (isDark ? "#c586c0" : "#a626a4"),
      cyan: get("--color-cyan") || (isDark ? "#4ec9b0" : "#0184bc"),
      white: isDark ? "#d4d4d4" : "#fafafa",
      brightBlack: muted,
      brightRed: get("--color-red") || (isDark ? "#f44747" : "#e45649"),
      brightGreen: get("--color-green") || (isDark ? "#6a9955" : "#50a14f"),
      brightYellow: get("--color-yellow") || (isDark ? "#d7ba7d" : "#c18401"),
      brightBlue: get("--color-blue") || (isDark ? "#569cd6" : "#4078f2"),
      brightMagenta: get("--color-purple") || (isDark ? "#c586c0" : "#a626a4"),
      brightCyan: get("--color-cyan") || (isDark ? "#4ec9b0" : "#0184bc"),
      brightWhite: isDark ? "#ffffff" : "#ffffff",
    };
  }

  /** Cache the active file and selection so they persist when focus moves to terminal */
  private cacheEditorContext(): void {
    const file = this.app.workspace.getActiveFile();
    // Only update if we're looking at a real file (not the terminal itself)
    if (file) {
      this.lastActiveFile = file.path;
      // Cache selection
      const editor = this.app.workspace.activeEditor?.editor;
      if (editor) {
        const selection = editor.getSelection();
        if (selection && selection.length > 0) {
          const cursor = editor.getCursor("from");
          const cursorTo = editor.getCursor("to");
          this.lastSelection = `(lines ${cursor.line + 1}-${cursorTo.line + 1})`;
        } else {
          this.lastSelection = null;
        }
      } else {
        this.lastSelection = null;
      }
    }
  }

  /** Refit the xterm canvas and send resize to the PTY relay */
  private handleResize(): void {
    if (!this.fitAddon || !this.terminal) return;
    try {
      this.fitAddon.fit();
      if (this.childProc?.stdin?.writable) {
        const msg = JSON.stringify({ resize: [this.terminal.cols, this.terminal.rows] });
        this.childProc.stdin.write(msg + "\n");
      }
    } catch {
      // Ignore transient resize errors during teardown
    }
  }

  /** Spawn the Copilot CLI via a PTY relay running in system Node */
  private spawnCopilot(): void {
    if (!this.terminal) return;

    const { spawn } = require("child_process") as typeof import("child_process");
    const path = require("path") as typeof import("path");
    const vaultPath = (this.app.vault.adapter as any).basePath as string;
    const pluginDir = path.join(vaultPath, ".obsidian", "plugins", "obsidian-copilot");
    const relayScript = path.join(pluginDir, "pty-relay.js");

    const settings = this.plugin.settings;
    const cwd = settings.workingDirectory === "vault" ? vaultPath : settings.workingDirectory;
    const cmd = `copilot ${settings.copilotFlags}`.trim();

    // Build environment
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      COLUMNS: String(this.terminal.cols),
      LINES: String(this.terminal.rows),
      COPILOT_CWD: cwd,
      COPILOT_CMD: cmd,
      NODE_PATH: path.join(pluginDir, "node_modules"),
    };

    try {
      this.childProc = spawn("node", [relayScript], {
        cwd: cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      // relay stdout -> xterm
      this.childProc.stdout?.on("data", (data: Buffer) => {
        this.terminal?.write(data.toString("utf-8"));
      });

      // relay stderr -> xterm
      this.childProc.stderr?.on("data", (data: Buffer) => {
        this.terminal?.write(data.toString("utf-8"));
      });

      // xterm input -> relay stdin (with optional context injection on Enter)
      this.terminal.onData((data: string) => {
        if (this.restartPending) {
          this.restartPending = false;
          this.restart();
          return;
        }
        this.handleInput(data);
      });

      // Handle process exit
      this.childProc.on("exit", (code: number | null) => {
        this.terminal?.write(
          `\r\n\x1b[90m[Copilot exited (code ${code ?? 0}). Press any key to restart]\x1b[0m\r\n`
        );
        this.restartPending = true;
      });

      this.childProc.on("error", (err: Error) => {
        this.terminal?.write(`\x1b[31mProcess error: ${err.message}\x1b[0m\r\n`);
      });
    } catch (e: any) {
      this.terminal.write(
        `\x1b[31mFailed to start Copilot CLI: ${e.message}\x1b[0m\r\n\r\n`
      );
      this.terminal.write(
        "\x1b[90mTroubleshooting:\r\n" +
          "  1. Ensure GitHub Copilot CLI is installed (copilot in PATH)\r\n" +
          "  2. Ensure Node.js is in PATH\r\n" +
          "  3. Restart Obsidian after making changes\x1b[0m\r\n"
      );
    }
  }

  /** Send text input to the PTY (used by commands like "send file context") */
  sendInput(text: string): void {
    this.childProc?.stdin?.write(text);
  }

  /**
   * Handle terminal input with context injection.
   * When auto-inject is on: buffers input locally, echoes to xterm directly,
   * and on Enter sends the full line with @file prefix to the PTY.
   */
  private handleInput(data: string): void {
    // If context injection is disabled, pass through directly
    if (!this.plugin.settings.autoInjectContext) {
      this.childProc?.stdin?.write(data);
      return;
    }

    // Handle special keys
    if (data === "\r" || data === "\n") {
      // Enter pressed — send with context prefix if there's input
      if (this.inputBuffer.trim().length > 0) {
        this.injectContextAndSend();
      } else {
        // Empty line — just forward Enter
        this.childProc?.stdin?.write("\r");
      }
      this.inputBuffer = "";
      return;
    }

    if (data === "\x7f" || data === "\b") {
      // Backspace — remove last char from buffer
      if (this.inputBuffer.length > 0) {
        this.inputBuffer = this.inputBuffer.slice(0, -1);
      }
      this.childProc?.stdin?.write(data);
      return;
    }

    if (data === "\x15") {
      // Ctrl+U — clear line
      this.inputBuffer = "";
      this.childProc?.stdin?.write(data);
      return;
    }

    if (data === "\x17") {
      // Ctrl+W — delete word
      this.inputBuffer = this.inputBuffer.replace(/\S+\s*$/, "");
      this.childProc?.stdin?.write(data);
      return;
    }

    if (data === "\x03") {
      // Ctrl+C — reset buffer
      this.inputBuffer = "";
      this.childProc?.stdin?.write(data);
      return;
    }

    // Control sequences (arrows, escape, etc.) — pass through without buffering
    if (data.length > 1 && data[0] === "\x1b") {
      this.childProc?.stdin?.write(data);
      return;
    }

    if (data.charCodeAt(0) < 32 && data !== "\t") {
      // Other control chars — pass through
      this.childProc?.stdin?.write(data);
      return;
    }

    // Regular character(s) — buffer and forward
    this.inputBuffer += data;
    this.childProc?.stdin?.write(data);
  }

  /**
   * Send user's message with @file prefix prepended.
   * Kills the current line (Ctrl+U) and re-sends as one atomic message.
   * Uses cached selection since focus moves to terminal before Enter.
   */
  private injectContextAndSend(): void {
    const file = this.lastActiveFile;
    if (!file) {
      // No active file — just send Enter normally
      this.childProc?.stdin?.write("\r");
      return;
    }

    // Build context prefix
    let contextPrefix = `@${file} `;

    // Use cached selection (captured before focus moved to terminal)
    if (this.lastSelection) {
      contextPrefix += `${this.lastSelection} `;
    }

    // Single atomic write: Ctrl+U (kill line) + full replacement + Enter
    const fullMessage = "\x15" + contextPrefix + this.inputBuffer + "\r";
    this.childProc?.stdin?.write(fullMessage);
  }

  /** Focus the xterm terminal element */
  focusTerminal(): void {
    this.terminal?.focus();
  }

  /** Kill the current process and start a fresh Copilot session */
  restart(): void {
    this.killProcess();
    if (this.terminal) {
      this.terminal.clear();
      this.terminal.write("\x1b[2J\x1b[H");
    }
    this.spawnCopilot();
  }

  private killProcess(): void {
    if (this.childProc) {
      try {
        this.childProc.kill();
      } catch {
        // Already dead
      }
      this.childProc = null;
    }
  }

  async onClose(): Promise<void> {
    this.killProcess();
    this.resizeObserver?.disconnect();
    this.themeMutationObserver?.disconnect();
    if (this.activeFileWatcher) {
      this.app.workspace.offref(this.activeFileWatcher);
    }
    this.terminal?.dispose();
    this.styleEl?.remove();
    this.terminal = null;
    this.fitAddon = null;
    this.resizeObserver = null;
    this.themeMutationObserver = null;
    this.styleEl = null;
  }
}

