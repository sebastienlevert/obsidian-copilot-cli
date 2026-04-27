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
  private inputBuffer: string = ""; // tracks current line input to detect commands like /clear
  private themeMutationObserver: MutationObserver | null = null;
  private documentKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private terminalWrapper: HTMLElement | null = null;

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
    this.terminalWrapper = wrapper;

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

    // --- Native keyboard & clipboard handling ---
    // Obsidian intercepts key events at the document level, so we must
    // stop propagation before they bubble up from the terminal.
    this.setupKeyboardInterception(wrapper);

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
      this.fitTerminal();
      this.spawnCopilot();
    });

    // Resize observer - refit terminal and notify PTY on container resize
    this.resizeObserver = new ResizeObserver(() => {
      this.handleResize();
    });
    this.resizeObserver.observe(wrapper);

    // Cache active file for PTY environment
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

  /**
   * Intercept keyboard and clipboard events so Obsidian doesn't steal them
   * from the terminal.
   *
   * Strategy:
   *  - attachCustomKeyEventHandler: tell xterm what to handle vs. ignore,
   *    and manually handle Ctrl+V paste / Ctrl+C copy.
   *  - Wrapper bubble-phase listener: call stopPropagation() AFTER xterm
   *    has processed the event so it never reaches Obsidian's hotkey system
   *    (which listens higher up the DOM).
   */
  private setupKeyboardInterception(wrapper: HTMLElement): void {
    if (!this.terminal) return;

    // Tell xterm which keys it should handle vs. pass through.
    // Return true  → xterm processes the key normally.
    // Return false → xterm ignores the key.
    this.terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;

      // Let Obsidian keep its devtools / reload shortcuts
      if (mod && e.shiftKey && e.key === "I") return false;
      if (mod && e.key === "r") return false;
      if (e.key === "F11") return false;
      if (e.key === "F12") return false;

      // Ctrl+V → paste from clipboard. Handles text and images.
      // Return false so xterm doesn't also send raw \x16.
      if (mod && e.key === "v" && e.type === "keydown") {
        e.preventDefault();
        this.handlePaste();
        return false;
      }

      // Ctrl+Enter → send newline for multi-line input in Copilot CLI.
      // xterm sends \r for all Enter variants, so we handle this manually.
      if (e.ctrlKey && e.key === "Enter" && e.type === "keydown") {
        this.childProc?.stdin?.write("\n");
        e.preventDefault();
        return false;
      }

      // Shift+Enter → also used for new lines in some CLI tools.
      if (e.shiftKey && e.key === "Enter" && e.type === "keydown") {
        this.childProc?.stdin?.write("\n");
        e.preventDefault();
        return false;
      }

      // Ctrl+C with a selection → copy to clipboard, don't send SIGINT
      if (mod && e.key === "c" && this.terminal?.hasSelection()) {
        navigator.clipboard.writeText(this.terminal.getSelection());
        this.terminal.clearSelection();
        e.preventDefault();
        return false;
      }

      // Everything else: let xterm handle it
      return true;
    });

    // Bubble-phase listener on the wrapper: after xterm has processed the
    // event, stop it from bubbling up to Obsidian's document-level handlers.
    this.documentKeyHandler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;

      // Let passthrough shortcuts bubble to Obsidian
      if (mod && e.shiftKey && e.key === "I") return;
      if (mod && e.key === "r") return;
      if (e.key === "F11" || e.key === "F12") return;

      e.stopPropagation();
    };

    wrapper.addEventListener("keydown", this.documentKeyHandler, false);
    wrapper.addEventListener("keyup", this.documentKeyHandler, false);
  }

  /**
   * Read the clipboard and paste into the terminal. Handles both text and
   * image content. Images are saved to the vault and the file path is pasted.
   */
  private async handlePaste(): Promise<void> {
    if (!this.terminal) return;

    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        // Prefer text if available
        if (item.types.includes("text/plain")) {
          const blob = await item.getType("text/plain");
          const text = await blob.text();
          if (text) {
            this.terminal.paste(text);
            return;
          }
        }

        // Handle image types — save to vault and paste the path
        const imageType = item.types.find((t) => t.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          const ext = imageType.split("/")[1] === "jpeg" ? "jpg" : imageType.split("/")[1];
          const fileName = `paste-${Date.now()}.${ext}`;
          const folderPath = this.plugin.settings.imagePasteFolder || "copilot-images";

          // Ensure the folder exists
          if (!this.app.vault.getAbstractFileByPath(folderPath)) {
            await this.app.vault.createFolder(folderPath);
          }

          const filePath = `${folderPath}/${fileName}`;
          const buffer = await blob.arrayBuffer();
          await this.app.vault.createBinary(filePath, buffer);

          this.terminal.paste(filePath);
          return;
        }
      }
    } catch {
      // Fallback to readText (e.g. if clipboard.read() is not supported)
      try {
        const text = await navigator.clipboard.readText();
        if (text) this.terminal.paste(text);
      } catch {
        // Clipboard access denied — nothing to paste
      }
    }
  }

  /** Cache the active file */
  private cacheEditorContext(): void {
    const file = this.app.workspace.getActiveFile();
    if (file) {
      this.lastActiveFile = file.path;
    }
  }

  /**
   * Fit the terminal to its container, reducing rows by 1 to prevent the
   * Copilot CLI TUI from rendering an extra separator line at the bottom.
   * The FitAddon can over-count rows due to subpixel rounding in embedded
   * contexts like Obsidian.
   */
  private fitTerminal(): void {
    if (!this.fitAddon || !this.terminal) return;
    const dims = this.fitAddon.proposeDimensions();
    if (dims) {
      this.terminal.resize(dims.cols, Math.max(1, dims.rows - 1));
    }
  }

  /** Refit the xterm canvas and send resize to the PTY relay */
  private handleResize(): void {
    if (!this.fitAddon || !this.terminal) return;
    try {
      this.fitTerminal();
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
    const resumeFlag = settings.persistentSession && this.plugin.getMachineSessionId()
      ? ` --resume=${this.plugin.getMachineSessionId()}`
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
        // Track input to detect /clear command
        if (data === "\r" || data === "\n") {
          const cmd = this.inputBuffer.trim();
          if (cmd === "/clear") {
            this.onClearCommand();
          }
          this.inputBuffer = "";
        } else if (data === "\x7f" || data === "\b") {
          // Backspace
          this.inputBuffer = this.inputBuffer.slice(0, -1);
        } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
          this.inputBuffer += data;
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

  /** Handle /clear command — generate a new session ID so we don't resume the old conversation */
  private async onClearCommand(): Promise<void> {
    if (this.plugin.settings.persistentSession) {
      const crypto = require("crypto") as typeof import("crypto");
      this.plugin.setMachineSessionId(crypto.randomUUID());
      await this.plugin.saveSettings();
      console.log(`Copilot CLI: /clear detected — new session ID: ${this.plugin.getMachineSessionId()}`);
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
    if (this.documentKeyHandler && this.terminalWrapper) {
      this.terminalWrapper.removeEventListener("keydown", this.documentKeyHandler, false);
      this.terminalWrapper.removeEventListener("keyup", this.documentKeyHandler, false);
      this.documentKeyHandler = null;
    }
    this.terminalWrapper = null;
    this.terminal?.dispose();
    this.styleEl?.remove();
    this.terminal = null;
    this.fitAddon = null;
    this.resizeObserver = null;
    this.themeMutationObserver = null;
    this.styleEl = null;
  }
}

