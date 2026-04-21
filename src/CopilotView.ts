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
  private lastActiveFile: string | null = null;
  private fileOpenRef: any = null;
  private leafChangeRef: any = null;
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

    // Watch active file/selection — write to .context file so Copilot
    // can discover the active file via instructions in AGENTS.md

    // file-open is the most reliable event — Obsidian passes the file directly
    this.fileOpenRef = this.app.workspace.on("file-open", (file) => {
      if (file) {
        this.lastActiveFile = file.path;
        this.writeContextFile();
      }
    });
    this.registerEvent(this.fileOpenRef);

    // active-leaf-change — update file when switching to a markdown leaf
    this.leafChangeRef = this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf?.view?.getViewType() === "markdown") {
        const file = this.app.workspace.getActiveFile();
        if (file) this.lastActiveFile = file.path;
        this.writeContextFile();
      }
    });
    this.registerEvent(this.leafChangeRef);

    // Initial context write
    this.cacheEditorContext();
    this.writeContextFile();
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

  /** Cache the active file */
  private cacheEditorContext(): void {
    const file = this.app.workspace.getActiveFile();
    if (file) {
      this.lastActiveFile = file.path;
    }
  }

  /**
   * Write the current context to a .context file in the plugin folder.
   * Copilot reads this via instructions in AGENTS.md — no readline manipulation needed.
   */
  private writeContextFile(): void {
    if (!this.plugin.settings.autoInjectContext) return;

    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const vaultPath = (this.app.vault.adapter as any).basePath as string;
    const contextPath = path.join(vaultPath, this.plugin.manifest.dir, ".context");

    const lines: string[] = [];
    if (this.lastActiveFile) {
      lines.push(`PENSIEVE_ACTIVE_FILE=${this.lastActiveFile}`);
    }
    lines.push(`PENSIEVE_UPDATED=${new Date().toISOString()}`);

    try {
      fs.writeFileSync(contextPath, lines.join("\n") + "\n", "utf-8");
    } catch {
      // Silently ignore write errors (plugin dir may not exist yet)
    }
  }

  /** Refit the xterm canvas and send resize to the PTY relay */
  private handleResize(): void {
    if (!this.fitAddon || !this.terminal) return;
    try {
      this.fitAddon.fit();
      if (this.childProc?.stdin?.writable) {
        // ConPTY bridge resize protocol: escape sequence parsed by the Rust binary
        this.childProc.stdin.write(`\x1b]resize;${this.terminal.cols};${this.terminal.rows}\x07`);
      }
    } catch {
      // Ignore transient resize errors during teardown
    }
  }

  /** Spawn the Copilot CLI via the ConPTY bridge (no node-pty needed) */
  private spawnCopilot(): void {
    if (!this.terminal) return;

    const { spawn } = require("child_process") as typeof import("child_process");
    const path = require("path") as typeof import("path");
    const vaultPath = (this.app.vault.adapter as any).basePath as string;
    const pluginDir = path.join(vaultPath, this.plugin.manifest.dir);
    const bridgePath = path.join(pluginDir, "conpty-bridge.exe");

    const settings = this.plugin.settings;
    const cwd = settings.workingDirectory === "vault" ? vaultPath : settings.workingDirectory;
    const resumeFlag = settings.persistentSession && settings.sessionId
      ? ` --resume=${settings.sessionId}`
      : "";
    const cmd = `copilot ${settings.copilotFlags}${resumeFlag}`.trim();

    // Build the full shell command for ConPTY
    const shellCmd = `powershell.exe -NoLogo -NoProfile -Command ${cmd}`;

    try {
      this.childProc = spawn(bridgePath, [
        String(this.terminal.cols),
        String(this.terminal.rows),
        cwd,
        shellCmd,
      ], {
        cwd: cwd,
        env: {
          ...process.env as Record<string, string>,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          PENSIEVE_ACTIVE_FILE: this.lastActiveFile || "",
        },
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

      // xterm input -> PTY stdin (simple passthrough — context is via .context file)
      this.terminal.onData((data: string) => {
        if (this.restartPending) {
          this.restartPending = false;
          this.restart();
          return;
        }
        this.childProc?.stdin?.write(data);
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
          "  2. Ensure conpty-bridge.exe exists in the plugin folder\r\n" +
          "  3. Restart Obsidian after making changes\x1b[0m\r\n"
      );
    }
  }

  /** Send text input to the PTY (used by commands like "send file context") */
  sendInput(text: string): void {
    this.childProc?.stdin?.write(text);
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
    this.terminal?.dispose();
    this.styleEl?.remove();
    this.terminal = null;
    this.fitAddon = null;
    this.resizeObserver = null;
    this.themeMutationObserver = null;
    this.styleEl = null;
  }
}

