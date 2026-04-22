import { Plugin, addIcon, Notice, requestUrl } from "obsidian";
import { CopilotView } from "./CopilotView";
import { CopilotSettingTab } from "./CopilotSettingTab";
import { VIEW_TYPE_COPILOT, ICON_COPILOT, COPILOT_ICON_SVG, DEFAULT_SETTINGS } from "./constants";
import type { CopilotSettings, Placement } from "./constants";
import { ContextProvider } from "./ContextProvider";
import { ContextWriter } from "./ContextWriter";
import { McpRegistrar } from "./McpRegistrar";

export default class CopilotPlugin extends Plugin {
  settings: CopilotSettings = { ...DEFAULT_SETTINGS };
  contextProvider: ContextProvider | null = null;
  contextWriter: ContextWriter | null = null;
  private mcpRegistrar: McpRegistrar | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Generate a persistent session ID on first use
    if (this.settings.persistentSession && !this.settings.sessionId) {
      this.settings.sessionId = require("crypto").randomUUID();
      await this.saveSettings();
    }

    // Ensure ConPTY bridge binary exists (downloads on first BRAT install)
    try {
      await this.ensureConPtyBridge();
    } catch (e) {
      console.error("Copilot CLI: ensureConPtyBridge failed", e);
    }

    // Initialize IDE state system (writes obsidian-state.json for MCP server)
    const vaultPath = (this.app.vault.adapter as any).basePath as string;
    this.contextProvider = new ContextProvider(this.app, this.settings);
    this.contextWriter = new ContextWriter(this.contextProvider, this.settings, vaultPath);

    // Register MCP server so Copilot CLI can discover Obsidian as an IDE
    const pathMod = require("path") as typeof import("path");
    const pluginDir = pathMod.join(vaultPath, this.manifest.dir);
    this.mcpRegistrar = new McpRegistrar(vaultPath, pluginDir);
    this.mcpRegistrar.register();

    // Register custom Copilot icon
    addIcon(ICON_COPILOT, COPILOT_ICON_SVG);

    // Register the Copilot terminal view
    this.registerView(VIEW_TYPE_COPILOT, (leaf) => new CopilotView(leaf, this));

    // Settings tab
    this.addSettingTab(new CopilotSettingTab(this.app, this));

    // Command: Open Copilot (default placement)
    this.addCommand({
      id: "open-copilot",
      name: "Open Copilot",
      callback: () => this.activateView(),
    });

    // Command: Toggle focus between editor and Copilot
    this.addCommand({
      id: "toggle-copilot-focus",
      name: "Toggle focus to/from Copilot",
      callback: () => this.toggleFocus(),
    });

    // Command: Restart Copilot session
    this.addCommand({
      id: "restart-copilot",
      name: "Restart Copilot session",
      callback: () => {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_COPILOT);
        for (const leaf of leaves) {
          (leaf.view as CopilotView).restart();
        }
      },
    });

    // Command: Send current file to Copilot (uses @file syntax)
    this.addCommand({
      id: "send-file-to-copilot",
      name: "Add current file as context in Copilot",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return;
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_COPILOT);
        if (leaves.length === 0) {
          this.activateView();
          return;
        }
        // @path tells Copilot CLI to read the file as context (like #file in VS Code)
        (leaves[0].view as CopilotView).sendInput(`@${file.path} `);
        this.app.workspace.setActiveLeaf(leaves[0], { focus: true });
        (leaves[0].view as CopilotView).focusTerminal();
      },
    });

    // Command: Send selection to Copilot
    this.addCommand({
      id: "send-selection-to-copilot",
      name: "Add selection as context in Copilot",
      callback: () => {
        const editor = this.app.workspace.activeEditor?.editor;
        if (!editor) return;
        const selection = editor.getSelection();
        if (!selection) return;
        const file = this.app.workspace.getActiveFile();
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_COPILOT);
        if (leaves.length === 0) {
          this.activateView();
          return;
        }
        const view = leaves[0].view as CopilotView;
        // Reference the file + paste selection so Copilot has both file context and the excerpt
        if (file) {
          view.sendInput(`@${file.path} `);
        }
        view.sendInput(`"${selection}" `);
        this.app.workspace.setActiveLeaf(leaves[0], { focus: true });
        view.focusTerminal();
      },
    });

    // Placement-specific commands
    this.addCommand({ id: "open-copilot-tab", name: "Open Copilot in new tab", callback: () => this.activateView("tab") });
    this.addCommand({ id: "open-copilot-right", name: "Open Copilot in right sidebar", callback: () => this.activateView("right") });
    this.addCommand({ id: "open-copilot-left", name: "Open Copilot in left sidebar", callback: () => this.activateView("left") });
    this.addCommand({ id: "open-copilot-bottom", name: "Open Copilot in bottom pane", callback: () => this.activateView("bottom") });
    this.addCommand({ id: "open-copilot-split", name: "Open Copilot in split pane", callback: () => this.activateView("split") });

    // Auto-open on vault load
    if (this.settings.autoOpen) {
      this.app.workspace.onLayoutReady(() => {
        this.activateView();
      });
    }
  }

  /** Toggle keyboard focus between the editor and the Copilot terminal */
  private toggleFocus(): void {
    const copilotLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_COPILOT);
    if (copilotLeaves.length === 0) {
      this.activateView();
      return;
    }

    const activeLeaf = this.app.workspace.activeLeaf;
    if (activeLeaf && activeLeaf.view.getViewType() === VIEW_TYPE_COPILOT) {
      // Currently in Copilot — switch back to last editor
      const editorLeaf = this.app.workspace.getMostRecentLeaf();
      if (editorLeaf && editorLeaf !== activeLeaf) {
        this.app.workspace.setActiveLeaf(editorLeaf, { focus: true });
      }
    } else {
      // Currently in editor — switch to Copilot
      this.app.workspace.setActiveLeaf(copilotLeaves[0], { focus: true });
      (copilotLeaves[0].view as CopilotView).focusTerminal();
    }
  }

  /** Open or reveal the Copilot terminal view */
  async activateView(placement?: Placement): Promise<void> {
    const { workspace } = this.app;
    const target = placement || this.settings.defaultPlacement;

    // Reuse existing leaf if no explicit placement override
    if (!placement) {
      const existing = workspace.getLeavesOfType(VIEW_TYPE_COPILOT);
      if (existing.length > 0) {
        workspace.revealLeaf(existing[0]);
        return;
      }
    }

    let leaf;
    switch (target) {
      case "tab":
        leaf = workspace.getLeaf("tab");
        break;
      case "right":
        leaf = workspace.getRightLeaf(false);
        break;
      case "left":
        leaf = workspace.getLeftLeaf(false);
        break;
      case "split":
        leaf = workspace.getLeaf("split");
        break;
      case "bottom":
        leaf = workspace.getLeaf("split", "horizontal");
        break;
    }

    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_COPILOT, active: true });
      workspace.revealLeaf(leaf);
    }
  }

  /** Download conpty-bridge.exe from GitHub release if missing (BRAT installs) */
  private async ensureConPtyBridge(): Promise<void> {
    try {
      const path = require("path") as typeof import("path");
      const fs = require("fs") as typeof import("fs");
      const vaultPath = (this.app.vault.adapter as any).basePath as string;
      const pluginDir = path.join(vaultPath, this.manifest.dir);
      const bridgePath = path.join(pluginDir, "conpty-bridge.exe");

      if (fs.existsSync(bridgePath)) return;

      const url = `https://github.com/sebastienlevert/obsidian-copilot-cli/releases/latest/download/conpty-bridge.exe`;
      new Notice("Copilot CLI: Downloading ConPTY bridge...");
      const response = await requestUrl({ url });
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(bridgePath, Buffer.from(response.arrayBuffer));
      new Notice("Copilot CLI: ConPTY bridge ready.");
    } catch (e) {
      console.error("Copilot CLI: ensureConPtyBridge failed", e);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // Propagate settings changes to the context system
    this.contextProvider?.updateSettings(this.settings);
    this.contextWriter?.updateSettings(this.settings);
  }

  onunload(): void {
    // Cancel any pending state writes
    this.contextWriter?.cancel();
    // Views are automatically cleaned up by Obsidian
  }
}
