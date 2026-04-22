import { App, TFile } from "obsidian";
import type { CopilotSettings } from "./constants";

/**
 * Collects IDE state from the Obsidian API and generates a JSON state object
 * for the MCP server's obsidian-state.json sidecar file.
 */
export class ContextProvider {
  private app: App;
  private settings: CopilotSettings;

  // Persists last non-empty selection so it survives editor blur (e.g. clicking terminal)
  private lastSelection: { text: string; startLine: number; startCh: number; endLine: number; endCh: number; file: string } | null = null;

  constructor(app: App, settings: CopilotSettings) {
    this.app = app;
    this.settings = settings;
  }

  updateSettings(settings: CopilotSettings): void {
    this.settings = settings;
  }

  /** Clear the cached selection (e.g. when a new file is opened) */
  clearCachedSelection(): void {
    this.lastSelection = null;
  }

  /** Generate JSON state object for MCP server consumption */
  generateStateJson(): Record<string, unknown> {
    const file = this.app.workspace.getActiveFile();
    const editor = this.app.workspace.activeEditor?.editor;

    // Open files
    const openFiles: string[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view?.getViewType() === "markdown") {
        const f = (leaf.view as any)?.file as TFile | undefined;
        if (f && !openFiles.includes(f.path)) {
          openFiles.push(f.path);
        }
      }
    });

    // Selection — use live if available, fall back to cached
    let selection: Record<string, unknown> | null = null;
    if (editor) {
      const selText = editor.getSelection();
      if (selText && selText.trim().length > 0) {
        const from = editor.getCursor("from");
        const to = editor.getCursor("to");
        this.lastSelection = {
          text: selText,
          startLine: from.line + 1,
          startCh: from.ch,
          endLine: to.line + 1,
          endCh: to.ch,
          file: file?.path || "",
        };
        selection = {
          text: selText.length > 5000 ? selText.slice(0, 5000) : selText,
          startLine: from.line + 1,
          startCh: from.ch,
          endLine: to.line + 1,
          endCh: to.ch,
        };
      }
    }
    if (!selection && this.lastSelection) {
      selection = {
        text: this.lastSelection.text.length > 5000 ? this.lastSelection.text.slice(0, 5000) : this.lastSelection.text,
        startLine: this.lastSelection.startLine,
        startCh: this.lastSelection.startCh,
        endLine: this.lastSelection.endLine,
        endCh: this.lastSelection.endCh,
      };
    }

    // Metadata
    let metadata: Record<string, unknown> | null = null;
    if (file) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (cache) {
        metadata = {};
        if (cache.frontmatter) {
          const fm: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(cache.frontmatter)) {
            if (key !== "position") fm[key] = value;
          }
          metadata.frontmatter = fm;
        }
        if (cache.tags && cache.tags.length > 0) {
          metadata.tags = cache.tags.map((t) => t.tag);
        }
        if (cache.links && cache.links.length > 0) {
          metadata.outgoingLinks = cache.links.map((l) => l.link);
        }
      }
    }

    // Vault path (from adapter)
    const vaultPath = (this.app.vault.adapter as any).basePath || "";

    return {
      activeFile: file ? file.path : null,
      selection,
      openFiles,
      vaultPath,
      metadata,
      timestamp: Date.now(),
    };
  }
}
