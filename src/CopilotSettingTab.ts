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

    containerEl.createEl("h2", { text: "Context Injection" });

    new Setting(containerEl)
      .setName("Auto-inject file context")
      .setDesc(
        "Write the active file path and selection to a .context file that Copilot can read. " +
        "AGENTS.md instructions tell Copilot to check this file for context."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoInjectContext)
          .onChange(async (value) => {
            this.plugin.settings.autoInjectContext = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
