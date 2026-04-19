import { ItemView, WorkspaceLeaf } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { VIEW_TYPE_COPILOT, COPILOT_CMD } from "./constants";

// xterm.js CSS (injected at runtime)
import xtermCss from "@xterm/xterm/css/xterm.css";

// node-pty is external — loaded at runtime from Electron's Node context
const pty = require("node-pty");

export class CopilotView extends ItemView {
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private ptyProcess: any = null;
  private resizeObserver: ResizeObserver | null = null;
  private styleEl: HTMLStyleElement | null = null;
  private exitListenerDispose: (() => void) | null = null;
  private restartPending = false;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_COPILOT;
  }

  getDisplayText(): string {
    return "Copilot";
  }

  getIcon(): string {
    return "terminal";
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

    // Initialize xterm.js
    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'Cascadia Code', 'Fira Code', Consolas, 'Courier New', monospace",
      theme: {
        background: "#1e1e1e",
        foreground: "#cccccc",
        cursor: "#ffffff",
        selectionBackground: "#264f78",
        black: "#1e1e1e",
        red: "#f44747",
        green: "#6a9955",
        yellow: "#d7ba7d",
        blue: "#569cd6",
        magenta: "#c586c0",
        cyan: "#4ec9b0",
        white: "#d4d4d4",
        brightBlack: "#808080",
        brightRed: "#f44747",
        brightGreen: "#6a9955",
        brightYellow: "#d7ba7d",
        brightBlue: "#569cd6",
        brightMagenta: "#c586c0",
        brightCyan: "#4ec9b0",
        brightWhite: "#ffffff",
      },
      allowProposedApi: true,
      scrollback: 10000,
    });

    // Addons
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon());

    // Try WebGL renderer for performance, fall back to canvas
    try {
      this.terminal.loadAddon(new WebglAddon());
    } catch {
      // WebGL not available, canvas renderer is fine
    }

    this.terminal.open(wrapper);

    // Delay fit to allow DOM layout to settle, then spawn
    requestAnimationFrame(() => {
      this.fitAddon?.fit();
      this.spawnCopilot();
    });

    // Resize observer — refit terminal and notify PTY on container resize
    this.resizeObserver = new ResizeObserver(() => {
      this.handleResize();
    });
    this.resizeObserver.observe(wrapper);
  }

  /** Refit the xterm canvas and send resize signal to PTY */
  private handleResize(): void {
    if (!this.fitAddon || !this.terminal) return;
    try {
      this.fitAddon.fit();
      if (this.ptyProcess) {
        this.ptyProcess.resize(this.terminal.cols, this.terminal.rows);
      }
    } catch {
      // Ignore transient resize errors during teardown
    }
  }

  /** Spawn the Copilot CLI in a real PTY */
  private spawnCopilot(): void {
    if (!this.terminal) return;

    const vaultPath = (this.app.vault.adapter as any).basePath as string;
    const isWin = process.platform === "win32";

    // Use the platform shell to launch copilot so PATH resolution works
    const shell = isWin ? "powershell.exe" : process.env.SHELL || "/bin/bash";
    const args = isWin
      ? ["-NoLogo", "-NoProfile", "-Command", COPILOT_CMD]
      : ["-l", "-c", COPILOT_CMD];

    try {
      this.ptyProcess = pty.spawn(shell, args, {
        name: "xterm-256color",
        cols: this.terminal.cols,
        rows: this.terminal.rows,
        cwd: vaultPath,
        env: { ...process.env } as Record<string, string>,
      });

      // PTY → xterm
      this.ptyProcess.onData((data: string) => {
        this.terminal?.write(data);
      });

      // xterm → PTY
      this.terminal.onData((data: string) => {
        this.ptyProcess?.write(data);
      });

      // Handle process exit
      this.ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
        this.terminal?.write(
          `\r\n\x1b[90m[Copilot exited (code ${exitCode}). Press any key to restart]\x1b[0m\r\n`
        );
        this.restartPending = true;
      });

      // Restart on keypress after exit
      this.exitListenerDispose = this.terminal.onData(() => {
        if (this.restartPending) {
          this.restartPending = false;
          this.restart();
        }
      }).dispose;
    } catch (e: any) {
      this.terminal.write(
        `\x1b[31mFailed to start Copilot CLI: ${e.message}\x1b[0m\r\n\r\n`
      );
      this.terminal.write(
        "\x1b[90mTroubleshooting:\r\n" +
          "  1. Ensure GitHub Copilot CLI is installed: npm i -g @githubnext/github-copilot-cli\r\n" +
          "  2. Ensure 'copilot' is in your PATH\r\n" +
          "  3. Check that node-pty native module is rebuilt for Obsidian's Electron\r\n" +
          "     Run: npm run rebuild-pty\x1b[0m\r\n"
      );
    }
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
    if (this.ptyProcess) {
      try {
        this.ptyProcess.kill();
      } catch {
        // Already dead
      }
      this.ptyProcess = null;
    }
  }

  async onClose(): Promise<void> {
    this.killProcess();
    this.exitListenerDispose?.();
    this.resizeObserver?.disconnect();
    this.terminal?.dispose();
    this.styleEl?.remove();
    this.terminal = null;
    this.fitAddon = null;
    this.resizeObserver = null;
    this.styleEl = null;
  }
}
