import type { CopilotSettings } from "./constants";
import type { ContextProvider } from "./ContextProvider";

const STATE_WRITE_DEBOUNCE_MS = 500;

/**
 * Handles writing the obsidian-state.json sidecar file used by the MCP server.
 * Debounces writes to avoid excessive disk I/O on rapid editor events.
 */
export class ContextWriter {
  private provider: ContextProvider;
  private settings: CopilotSettings;
  private vaultPath: string;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private writing = false;
  private pendingWrite = false;
  private gitignoreChecked = false;

  constructor(provider: ContextProvider, settings: CopilotSettings, vaultPath: string) {
    this.provider = provider;
    this.settings = settings;
    this.vaultPath = vaultPath;
  }

  updateSettings(settings: CopilotSettings): void {
    this.settings = settings;
  }

  /** Schedule a debounced state write */
  scheduleWrite(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.executeWrite();
    }, STATE_WRITE_DEBOUNCE_MS);
  }

  /** Force an immediate write (used on Copilot spawn) */
  async writeNow(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    await this.executeWrite();
  }

  /** Cancel any pending writes */
  cancel(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private async executeWrite(): Promise<void> {
    if (this.writing) {
      this.pendingWrite = true;
      return;
    }

    this.writing = true;
    try {
      await this.doWrite();
    } finally {
      this.writing = false;
      if (this.pendingWrite) {
        this.pendingWrite = false;
        this.scheduleWrite();
      }
    }
  }

  private async doWrite(): Promise<void> {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");

    const githubDir = path.join(this.vaultPath, ".github");

    try {
      // Ensure .github directory exists
      if (!fs.existsSync(githubDir)) {
        fs.mkdirSync(githubDir, { recursive: true });
      }

      // Ensure the state file is gitignored (once per session)
      if (!this.gitignoreChecked) {
        this.ensureGitignore(fs, path);
        this.gitignoreChecked = true;
      }

      // Write JSON state file for MCP server
      const statePath = path.join(githubDir, "obsidian-state.json");
      const stateJson = JSON.stringify(this.provider.generateStateJson(), null, 2);
      const stateTmpPath = statePath + ".tmp";
      fs.writeFileSync(stateTmpPath, stateJson, "utf-8");
      fs.renameSync(stateTmpPath, statePath);
    } catch (e) {
      console.error("Copilot CLI: Failed to write state file", e);
    }
  }

  /**
   * Ensure .github/obsidian-state.json is in .gitignore so ephemeral
   * IDE state doesn't pollute version control in shared repos.
   */
  private ensureGitignore(fs: typeof import("fs"), path: typeof import("path")): void {
    const gitignorePath = path.join(this.vaultPath, ".gitignore");
    const stateEntry = ".github/obsidian-state.json";

    try {
      let content = "";
      if (fs.existsSync(gitignorePath)) {
        content = fs.readFileSync(gitignorePath, "utf-8");
      }

      const lines = content.split(/\r?\n/);
      if (lines.some((line) => line.trim() === stateEntry)) return;

      const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
      const comment = "# Obsidian IDE state for Copilot CLI MCP server";
      fs.appendFileSync(gitignorePath, `${separator}${comment}\n${stateEntry}\n`, "utf-8");
    } catch (e) {
      console.warn("Copilot CLI: Could not update .gitignore", e);
    }
  }
}
