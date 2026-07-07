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
      .setName("Copilot executable path")
      .setDesc(
        "Optional. Absolute path to the copilot launcher (e.g. copilot.cmd). Leave blank to auto-detect. Set this if launching fails with 'copilot is not recognized'."
      )
      .addText((text) =>
        text
          .setPlaceholder("auto-detect")
          .setValue(this.plugin.settings.copilotPath)
          .onChange(async (value) => {
            this.plugin.settings.copilotPath = value.trim();
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

    containerEl.createEl("h2", { text: "Integrations" });

    new Setting(containerEl)
      .setName("IDE integration")
      .setDesc(
        "Let the Copilot CLI's /ide command see Obsidian's active file and text selection. Turn this off if the CLI is slow to start or won't load, then reload."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableIdeIntegration)
          .onChange(async (value) => {
            this.plugin.settings.enableIdeIntegration = value;
            await this.plugin.saveSettings();
            await this.plugin.setIdeIntegration(value);
          })
      );

    new Setting(containerEl)
      .setName("Auto-connect IDE on start")
      .setDesc(
        "Automatically run /ide when the terminal starts so the CLI connects to Obsidian without typing it. Only applies when IDE integration is on."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoConnectIde)
          .onChange(async (value) => {
            this.plugin.settings.autoConnectIde = value;
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
            if (value && !this.plugin.getMachineSessionId()) {
              this.plugin.setMachineSessionId(require("crypto").randomUUID());
            }
            await this.plugin.saveSettings();
          })
      );
  }
}
