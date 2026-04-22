import { App, PluginSettingTab, Setting } from "obsidian";
import type CopilotPlugin from "./main";
import { DEFAULT_SETTINGS, Placement } from "./constants";

export class CopilotSettingTab extends PluginSettingTab {
  plugin: CopilotPlugin;

  constructor(app: App, plugin: CopilotPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Copilot Terminal" });

    new Setting(containerEl)
      .setName("Default placement")
      .setDesc("Where Copilot opens when you click the ribbon icon")
      .addDropdown((drop) =>
        drop
          .addOptions({
            right: "Right sidebar",
            left: "Left sidebar",
            bottom: "Bottom pane",
            tab: "New tab",
            split: "Split pane",
          })
          .setValue(this.plugin.settings.defaultPlacement)
          .onChange(async (value) => {
            this.plugin.settings.defaultPlacement = value as Placement;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-open on vault load")
      .setDesc("Automatically open Copilot when Obsidian starts")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoOpen)
          .onChange(async (value) => {
            this.plugin.settings.autoOpen = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Copilot CLI flags")
      .setDesc("Flags passed to the copilot command (e.g. --yolo --banner)")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.copilotFlags)
          .setValue(this.plugin.settings.copilotFlags)
          .onChange(async (value) => {
            this.plugin.settings.copilotFlags = value || DEFAULT_SETTINGS.copilotFlags;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Working directory")
      .setDesc("'vault' uses the vault root, or enter a custom absolute path")
      .addText((text) =>
        text
          .setPlaceholder("vault")
          .setValue(this.plugin.settings.workingDirectory)
          .onChange(async (value) => {
            this.plugin.settings.workingDirectory = value || "vault";
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h2", { text: "Session" });

    new Setting(containerEl)
      .setName("Persistent session")
      .setDesc(
        "Always resume the same Copilot session. A unique session ID is generated on first use and reused on every launch."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.persistentSession)
          .onChange(async (value) => {
            this.plugin.settings.persistentSession = value;
            if (value && !this.plugin.settings.sessionId) {
              this.plugin.settings.sessionId = require("crypto").randomUUID();
            }
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h2", { text: "Context Injection" });

    new Setting(containerEl)
      .setName("Auto-inject file context")
      .setDesc(
        "Automatically write IDE context (active file, open tabs, selections) to " +
        ".github/copilot-instructions.md so Copilot CLI sees it on every turn."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoInjectContext)
          .onChange(async (value) => {
            this.plugin.settings.autoInjectContext = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Include file content")
      .setDesc("Include the full content of the active file in context.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.contextIncludeFileContent)
          .onChange(async (value) => {
            this.plugin.settings.contextIncludeFileContent = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Include open files list")
      .setDesc("Include a list of all currently open files in context.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.contextIncludeOpenFiles)
          .onChange(async (value) => {
            this.plugin.settings.contextIncludeOpenFiles = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Include vault structure")
      .setDesc("Include a tree view of the vault file structure in context.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.contextIncludeVaultStructure)
          .onChange(async (value) => {
            this.plugin.settings.contextIncludeVaultStructure = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max file content size")
      .setDesc("Maximum size (in bytes) of active file content to include. Larger files are truncated.")
      .addText((text) =>
        text
          .setPlaceholder("50000")
          .setValue(String(this.plugin.settings.contextMaxFileSize))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.contextMaxFileSize = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Custom instructions")
      .setDesc(
        "Static instructions to always include in copilot-instructions.md. " +
        "These are placed before the auto-generated context."
      )
      .addTextArea((text) =>
        text
          .setPlaceholder("e.g., Always respond in the style of my vault conventions...")
          .setValue(this.plugin.settings.contextCustomInstructions)
          .onChange(async (value) => {
            this.plugin.settings.contextCustomInstructions = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
