import {
  CONTEXT_WRITE_DEBOUNCE_MS,
  CONTEXT_AUTO_MARKER_START,
  CONTEXT_AUTO_MARKER_END,
} from "./constants";
import type { CopilotSettings } from "./constants";
import type { ContextProvider } from "./ContextProvider";

/**
 * Handles writing the auto-generated IDE context to
 * .github/copilot-instructions.md with debouncing.
 *
 * Preserves any user-defined instructions outside the auto-generated markers.
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

  /** Schedule a debounced context write */
  scheduleWrite(): void {
    if (!this.settings.autoInjectContext) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.executeWrite();
    }, CONTEXT_WRITE_DEBOUNCE_MS);
  }

  /** Force an immediate write (used on Copilot spawn) */
  async writeNow(): Promise<void> {
    if (!this.settings.autoInjectContext) return;

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
    // Prevent concurrent writes
    if (this.writing) {
      this.pendingWrite = true;
      return;
    }

    this.writing = true;
    try {
      await this.doWrite();
    } finally {
      this.writing = false;
      // If another write was requested during this one, execute it
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
    const instructionsPath = path.join(githubDir, "copilot-instructions.md");

    try {
      // Ensure .github directory exists
      if (!fs.existsSync(githubDir)) {
        fs.mkdirSync(githubDir, { recursive: true });
      }

      // Ensure the instructions file is gitignored (once per session)
      if (!this.gitignoreChecked) {
        this.ensureGitignore(fs, path);
        this.gitignoreChecked = true;
      }

      // Read existing file to preserve user instructions
      let userInstructions = "";
      if (fs.existsSync(instructionsPath)) {
        const existing = fs.readFileSync(instructionsPath, "utf-8");
        userInstructions = this.extractUserInstructions(existing);
      }

      // Generate new auto-context
      const autoContext = await this.provider.generateContextAsync();

      // Combine: custom static instructions + user file instructions + auto context
      const parts: string[] = [];

      if (this.settings.contextCustomInstructions.trim()) {
        parts.push(this.settings.contextCustomInstructions.trim());
        parts.push("");
      }

      if (userInstructions.trim()) {
        parts.push(userInstructions.trim());
        parts.push("");
      }

      parts.push(CONTEXT_AUTO_MARKER_START);
      parts.push("");
      parts.push(autoContext);
      parts.push("");
      parts.push(CONTEXT_AUTO_MARKER_END);
      parts.push("");

      const content = parts.join("\n");

      // Atomic write: write to temp file, then rename
      const tmpPath = instructionsPath + ".tmp";
      fs.writeFileSync(tmpPath, content, "utf-8");
      fs.renameSync(tmpPath, instructionsPath);
    } catch (e) {
      console.error("Copilot CLI: Failed to write context instructions", e);
    }
  }

  /**
   * Ensure .github/copilot-instructions.md is in .gitignore so ephemeral
   * IDE context doesn't pollute version control in shared repos.
   */
  private ensureGitignore(fs: typeof import("fs"), path: typeof import("path")): void {
    const gitignorePath = path.join(this.vaultPath, ".gitignore");
    const entry = ".github/copilot-instructions.md";

    try {
      let content = "";
      if (fs.existsSync(gitignorePath)) {
        content = fs.readFileSync(gitignorePath, "utf-8");
      }

      // Check if already present (exact line match)
      const lines = content.split(/\r?\n/);
      if (lines.some((line) => line.trim() === entry)) {
        return;
      }

      // Append the entry
      const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
      const comment = "# Auto-generated Obsidian IDE context for Copilot CLI";
      fs.appendFileSync(gitignorePath, `${separator}${comment}\n${entry}\n`, "utf-8");
    } catch (e) {
      console.warn("Copilot CLI: Could not update .gitignore", e);
    }
  }

  /**
   * Extract user-written instructions from the file.
   * Everything outside the auto-generated markers is considered user content.
   */
  private extractUserInstructions(content: string): string {
    const startIdx = content.indexOf(CONTEXT_AUTO_MARKER_START);
    const endIdx = content.indexOf(CONTEXT_AUTO_MARKER_END);

    if (startIdx === -1 || endIdx === -1) {
      // No markers found — entire file is user content
      return content;
    }

    // Everything before the start marker and after the end marker is user content
    const before = content.slice(0, startIdx).trim();
    const after = content.slice(endIdx + CONTEXT_AUTO_MARKER_END.length).trim();

    const parts: string[] = [];
    if (before) parts.push(before);
    if (after) parts.push(after);

    return parts.join("\n\n");
  }
}
