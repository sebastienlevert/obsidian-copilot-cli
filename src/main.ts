import { Plugin } from "obsidian";
import { CopilotView } from "./CopilotView";
import { VIEW_TYPE_COPILOT, ICON_COPILOT } from "./constants";

export default class CopilotPlugin extends Plugin {
  async onload(): Promise<void> {
    // Register the Copilot terminal view
    this.registerView(VIEW_TYPE_COPILOT, (leaf) => new CopilotView(leaf));

    // Ribbon icon — opens the Copilot panel
    this.addRibbonIcon(ICON_COPILOT, "Open Copilot", () => {
      this.activateView();
    });

    // Command: Open Copilot
    this.addCommand({
      id: "open-copilot",
      name: "Open Copilot",
      callback: () => this.activateView(),
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

    // Command: Open Copilot in new pane
    this.addCommand({
      id: "open-copilot-new-pane",
      name: "Open Copilot in new pane",
      callback: () => this.activateView(true),
    });
  }

  /** Open or reveal the Copilot terminal view */
  async activateView(forceNew = false): Promise<void> {
    const { workspace } = this.app;

    // Reuse existing leaf unless forced
    if (!forceNew) {
      const existing = workspace.getLeavesOfType(VIEW_TYPE_COPILOT);
      if (existing.length > 0) {
        workspace.revealLeaf(existing[0]);
        return;
      }
    }

    // Open in the right sidebar by default
    const leaf = workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({
        type: VIEW_TYPE_COPILOT,
        active: true,
      });
      workspace.revealLeaf(leaf);
    }
  }

  onunload(): void {
    // Views are automatically cleaned up by Obsidian
  }
}
