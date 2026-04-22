import type { App, TFile } from "obsidian";
import type { ContextProvider } from "./ContextProvider";

/**
 * Native IDE connection server that implements the same protocol as VS Code's
 * Copilot Chat extension. Creates an HTTP server on a named pipe and writes
 * a lock file to ~/.copilot/ide/ so Copilot CLI's /ide command can discover it.
 *
 * Protocol:
 * - Express-like HTTP server on named pipe (Windows) or Unix socket
 * - MCP Streamable HTTP at /mcp endpoint
 * - Nonce-based auth via Authorization header
 * - Lock file at ~/.copilot/ide/<uuid>.lock with socket info
 */
export class IdeServer {
  private app: App;
  private contextProvider: ContextProvider;
  private vaultPath: string;
  private server: any = null; // http.Server
  private lockFilePath: string | null = null;
  private socketPath: string | null = null;
  private nonce: string | null = null;
  private sessions: Map<string, any> = new Map(); // sessionId -> transport
  private sseClients: Set<any> = new Set(); // active SSE response objects
  private running = false;
  private lastActiveFile: string | null = null; // vault-relative path of last active markdown file
  private lockFileDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(app: App, contextProvider: ContextProvider, vaultPath: string) {
    this.app = app;
    this.contextProvider = contextProvider;
    this.vaultPath = vaultPath;
  }

  /** Called by plugin on active-leaf-change to track the last markdown file */
  notifyActiveFile(filePath: string | null): void {
    if (filePath) this.lastActiveFile = filePath;
    this.updateLockFile();
    this.pushSseNotification();
  }

  /** Called by plugin on editor-change (selection/cursor change) */
  notifySelectionChange(): void {
    this.updateLockFile();
    this.pushSseNotification();
  }

  /** Update the lock file with current file context (debounced) */
  private updateLockFile(): void {
    if (!this.lockFilePath || !this.running) return;
    if (this.lockFileDebounceTimer) clearTimeout(this.lockFileDebounceTimer);
    this.lockFileDebounceTimer = setTimeout(() => this.writeLockFileUpdate(), 300);
  }

  /** Actually write the lock file update */
  private writeLockFileUpdate(): void {
    if (!this.lockFilePath || !this.running) return;
    const fs = require("fs") as typeof import("fs");
    try {
      const file = this.getActiveMarkdownFile();
      const editor = this.app.workspace.activeEditor?.editor;

      // Find editor from markdown leaves if not directly active
      let activeEditor = editor;
      if (!activeEditor) {
        this.app.workspace.iterateAllLeaves((leaf) => {
          if (!activeEditor && leaf.view?.getViewType() === "markdown") {
            activeEditor = (leaf.view as any)?.editor;
          }
        });
      }

      const filePath = file ? this.toAbsolutePath(file.path) : (this.lastActiveFile ? this.toAbsolutePath(this.lastActiveFile) : undefined);

      let selection: any;
      if (activeEditor && filePath) {
        const from = (activeEditor as any).getCursor("from");
        const to = (activeEditor as any).getCursor("to");
        selection = {
          start: { line: from.line + 1, character: from.ch },
          end: { line: to.line + 1, character: to.ch },
        };
      }

      const lockData = {
        socketPath: this.socketPath,
        scheme: process.platform === "win32" ? "pipe" : "unix",
        headers: { Authorization: `Nonce ${this.nonce}` },
        pid: process.pid,
        ideName: "Obsidian",
        timestamp: Date.now(),
        workspaceFolders: [this.vaultPath],
        isTrusted: true,
        ...(filePath ? { activeFile: filePath } : {}),
        ...(selection ? { selection } : {}),
      };

      fs.writeFileSync(this.lockFilePath, JSON.stringify(lockData, null, 2), { mode: 0o600 });
    } catch {}
  }

  /** Push notifications to all connected SSE clients */
  private pushSseNotification(): void {
    if (this.sseClients.size === 0) return;
    // Send both tools and resources list_changed to cover all CLI behaviors
    const notifications = [
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/resources/list_changed" }),
    ];
    for (const res of this.sseClients) {
      for (const n of notifications) {
        try { res.write(`data: ${n}\n\n`); } catch {}
      }
    }
  }

  /** Get the active markdown file, searching all leaves if needed */
  private getActiveMarkdownFile(): import("obsidian").TFile | null {
    const file = this.app.workspace.getActiveFile();
    if (file) return file;

    // Search leaves for a markdown file when terminal is focused
    let found: import("obsidian").TFile | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!found && leaf.view?.getViewType() === "markdown") {
        const f = (leaf.view as any)?.file as import("obsidian").TFile | undefined;
        if (f) found = f;
      }
    });
    return found;
  }

  /** Start the IDE server and write the lock file */
  async start(): Promise<void> {
    if (this.running) return;

    const http = require("http") as typeof import("http");
    const crypto = require("crypto") as typeof import("crypto");
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const os = require("os") as typeof import("os");

    this.nonce = crypto.randomUUID();
    const pipeId = crypto.randomUUID();

    // Socket path: named pipe on Windows, Unix socket elsewhere
    if (process.platform === "win32") {
      this.socketPath = `\\\\.\\pipe\\mcp-${pipeId}.sock`;
    } else {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-"));
      fs.chmodSync(tmpDir, 0o700);
      this.socketPath = path.join(tmpDir, "mcp.sock");
    }

    // Create HTTP server with manual routing (no Express dependency)
    this.server = http.createServer(async (req: any, res: any) => {
      // CORS headers for local connections
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, X-Copilot-Session-Id");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Auth check
      if (req.headers.authorization !== `Nonce ${this.nonce}`) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("Unauthorized");
        return;
      }

      // Route to /mcp endpoint
      const url = new URL(req.url || "/", `http://localhost`);
      if (url.pathname === "/mcp") {
        await this.handleMcp(req, res);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }
    });

    // Listen on the named pipe/socket
    await new Promise<void>((resolve, reject) => {
      this.server.listen(this.socketPath, () => resolve());
      this.server.on("error", reject);
    });

    this.running = true;

    // Write lock file
    await this.writeLockFile(fs, path, os);

    // Sweep stale lock files from other dead processes
    this.cleanStaleLockFiles(fs, path, os);

    console.log(`Copilot CLI: IDE server started on ${this.socketPath}`);
  }

  /** Stop the server and remove the lock file */
  async stop(): Promise<void> {
    if (!this.running) return;

    const fs = require("fs") as typeof import("fs");

    // Close all SSE connections
    for (const res of this.sseClients) {
      try { res.end(); } catch {}
    }
    this.sseClients.clear();

    // Close all sessions
    for (const [id, transport] of this.sessions) {
      try { await transport.close(); } catch {}
    }
    this.sessions.clear();

    // Close HTTP server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server.close(() => resolve());
        // Force-close existing connections
        this.server.closeAllConnections?.();
      });
      this.server = null;
    }

    // Remove lock file
    if (this.lockFilePath) {
      try { fs.unlinkSync(this.lockFilePath); } catch {}
      this.lockFilePath = null;
    }

    // Clean up socket path (Unix only)
    if (this.socketPath && process.platform !== "win32") {
      const path = require("path") as typeof import("path");
      try {
        fs.rmSync(path.dirname(this.socketPath), { recursive: true, force: true });
      } catch {}
    }

    this.socketPath = null;
    this.running = false;
    console.log("Copilot CLI: IDE server stopped");
  }

  /** Handle MCP requests at /mcp endpoint */
  private async handleMcp(req: any, res: any): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] || req.headers["x-copilot-session-id"];
    // Debug: uncomment to trace MCP requests
    // console.log(`Copilot CLI IDE: ${req.method} /mcp [session=${sessionId || 'none'}]`);

    if (req.method === "POST") {
      // Parse JSON body
      const body = await this.readBody(req);
      if (!body) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
        return;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
        return;
      }

      // Handle JSON-RPC
      // Debug: uncomment to trace JSON-RPC methods
      // console.log(`Copilot CLI IDE: JSON-RPC method=${parsed.method || (Array.isArray(parsed) ? 'batch' : 'unknown')}`, Array.isArray(parsed) ? parsed.map((m: any) => m.method) : (parsed.params?.name || ''));
      const response = await this.handleJsonRpc(parsed, sessionId);
      if (response) {
        const sessionHeader = response._sessionId || sessionId;
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (sessionHeader) {
          headers["Mcp-Session-Id"] = sessionHeader;
        }
        res.writeHead(200, headers);
        const { _sessionId, ...rest } = response;
        res.end(JSON.stringify(rest));
      } else {
        res.writeHead(202);
        res.end();
      }
    } else if (req.method === "GET") {
      // SSE endpoint for server-initiated notifications
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      });
      res.write(":ok\n\n");
      this.sseClients.add(res);
      req.on("close", () => {
        this.sseClients.delete(res);
      });
    } else if (req.method === "DELETE") {
      // Session termination
      if (sessionId && this.sessions.has(sessionId)) {
        this.sessions.delete(sessionId);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } else {
      res.writeHead(405);
      res.end();
    }
  }

  /** Handle a JSON-RPC request/notification */
  private async handleJsonRpc(msg: any, sessionId: string | undefined): Promise<any> {
    // Handle batch requests
    if (Array.isArray(msg)) {
      const results = await Promise.all(msg.map((m: any) => this.handleJsonRpc(m, sessionId)));
      return results.filter(Boolean);
    }

    const { method, id, params } = msg;

    // JSON-RPC notification (no id) — just acknowledge
    if (id === undefined || id === null) {
      return null;
    }

    try {
      switch (method) {
        case "initialize":
          return this.handleInitialize(id, params);
        case "tools/list":
          return this.handleToolsList(id);
        case "tools/call":
          return this.handleToolsCall(id, params);
        case "resources/list":
          return this.handleResourcesList(id);
        case "resources/read":
          return this.handleResourcesRead(id, params);
        case "ping":
          return { jsonrpc: "2.0", result: {}, id };
        default:
          return {
            jsonrpc: "2.0",
            error: { code: -32601, message: `Method not found: ${method}` },
            id,
          };
      }
    } catch (e: any) {
      return {
        jsonrpc: "2.0",
        error: { code: -32603, message: e.message || "Internal error" },
        id,
      };
    }
  }

  /** Handle MCP initialize */
  private handleInitialize(id: any, params: any): any {
    const crypto = require("crypto") as typeof import("crypto");
    const newSessionId = crypto.randomUUID();

    // Track the session
    this.sessions.set(newSessionId, { initialized: true, clientInfo: params?.clientInfo });

    return {
      jsonrpc: "2.0",
      result: {
        protocolVersion: "2025-03-26",
        capabilities: {
          tools: { listChanged: true },
          resources: { subscribe: false, listChanged: true },
        },
        serverInfo: {
          name: "obsidian-ide",
          version: "0.0.1",
        },
      },
      id,
      _sessionId: newSessionId,
    };
  }

  /** Handle tools/list */
  private handleToolsList(id: any): any {
    return {
      jsonrpc: "2.0",
      result: {
        tools: [
          {
            name: "get_vscode_info",
            description: "Get information about the current IDE instance",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "get_selection",
            description: 'Get text selection. Returns current selection if an editor is active, otherwise returns the latest cached selection. The "current" field indicates if this is from the active editor (true) or cached (false).',
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "get_diagnostics",
            description: "Gets language diagnostics (errors, warnings, hints) from the IDE",
            inputSchema: {
              type: "object",
              properties: {
                uri: {
                  type: "string",
                  description: "File URI to get diagnostics for. Optional. If not provided, returns diagnostics for all files.",
                },
              },
            },
          },
          {
            name: "open_diff",
            description: "Opens a diff view comparing original file content with new content. Blocks until user accepts, rejects, or closes the diff.",
            inputSchema: {
              type: "object",
              properties: {
                original_file_path: { type: "string", description: "Path to the original file" },
                new_file_contents: { type: "string", description: "The new file contents to compare against" },
                tab_name: { type: "string", description: "Name for the diff tab" },
              },
              required: ["original_file_path", "new_file_contents", "tab_name"],
            },
          },
          {
            name: "close_diff",
            description: "Closes a diff tab by its tab name.",
            inputSchema: {
              type: "object",
              properties: {
                tab_name: { type: "string", description: "The tab name of the diff to close" },
              },
              required: ["tab_name"],
            },
          },
          {
            name: "update_session_name",
            description: "Update the display name for the current CLI session",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string", description: "The new session name" },
              },
              required: ["name"],
            },
          },
        ],
      },
      id,
    };
  }

  /** Handle resources/list — expose current file as a resource */
  private handleResourcesList(id: any): any {
    const file = this.getActiveMarkdownFile();
    const resources: any[] = [];

    if (file) {
      const absPath = this.toAbsolutePath(file.path);
      const fileUrl = `file:///${absPath.replace(/\\/g, "/").replace(/^\//, "")}`;
      resources.push({
        uri: fileUrl,
        name: file.name,
        description: `Currently open file: ${file.path}`,
        mimeType: "text/markdown",
      });
    }

    // Also list all open files
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view?.getViewType() === "markdown") {
        const f = (leaf.view as any)?.file as import("obsidian").TFile | undefined;
        if (f && f !== file) {
          const absPath = this.toAbsolutePath(f.path);
          const fileUrl = `file:///${absPath.replace(/\\/g, "/").replace(/^\//, "")}`;
          if (!resources.find(r => r.uri === fileUrl)) {
            resources.push({
              uri: fileUrl,
              name: f.name,
              mimeType: "text/markdown",
            });
          }
        }
      }
    });

    return { jsonrpc: "2.0", result: { resources }, id };
  }

  /** Handle resources/read */
  private handleResourcesRead(id: any, params: any): any {
    const uri = params?.uri;
    if (!uri) {
      return { jsonrpc: "2.0", error: { code: -32602, message: "Missing uri parameter" }, id };
    }

    // Find the file by URI
    const path = require("path") as typeof import("path");
    const fs = require("fs") as typeof import("fs");
    let filePath: string;
    try {
      filePath = decodeURIComponent(new URL(uri).pathname).replace(/^\/([A-Za-z]:)/, "$1");
    } catch {
      return { jsonrpc: "2.0", error: { code: -32602, message: "Invalid URI" }, id };
    }

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return {
        jsonrpc: "2.0",
        result: {
          contents: [{ uri, mimeType: "text/markdown", text: content }],
        },
        id,
      };
    } catch (e: any) {
      return { jsonrpc: "2.0", error: { code: -32602, message: `Cannot read: ${e.message}` }, id };
    }
  }

  /** Handle tools/call */
  private async handleToolsCall(id: any, params: any): Promise<any> {
    const toolName = params?.name;
    const args = params?.arguments || {};

    let result: any;

    switch (toolName) {
      case "get_vscode_info":
        result = this.toolGetInfo();
        break;
      case "get_selection":
        result = this.toolGetSelection();
        break;
      case "get_diagnostics":
        result = this.toolGetDiagnostics(args.uri);
        break;
      case "open_diff":
        result = await this.toolOpenDiff(args.original_file_path, args.new_file_contents, args.tab_name);
        break;
      case "close_diff":
        result = this.toolCloseDiff(args.tab_name);
        break;
      case "update_session_name":
        result = { success: true };
        break;
      default:
        return {
          jsonrpc: "2.0",
          error: { code: -32602, message: `Unknown tool: ${toolName}` },
          id,
        };
    }

    return {
      jsonrpc: "2.0",
      result: {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      },
      id,
    };
  }

  // ── Tool implementations ──────────────────────────────────────────

  private toolGetInfo(): any {
    return {
      version: (this.app as any).version || "unknown",
      appName: "Obsidian",
      appRoot: this.vaultPath,
      language: navigator.language || "en",
      machineId: "obsidian",
      sessionId: "obsidian-session",
      uriScheme: "obsidian",
      shell: process.platform === "win32" ? "powershell" : process.env.SHELL || "/bin/sh",
    };
  }

  private toolGetSelection(): any {
    // Try to get the active markdown editor — may be null if terminal has focus
    let editor = this.app.workspace.activeEditor?.editor;
    let activeFile = this.app.workspace.getActiveFile();

    // If no active editor (e.g. terminal is focused), search for the most recent markdown leaf
    if (!editor) {
      this.app.workspace.iterateAllLeaves((leaf) => {
        if (!editor && leaf.view?.getViewType() === "markdown") {
          const e = (leaf.view as any)?.editor;
          const f = (leaf.view as any)?.file as import("obsidian").TFile | undefined;
          if (e) {
            editor = e;
            if (f) activeFile = f;
          }
        }
      });
    }

    if (editor && activeFile) {
      const selText = editor.getSelection();
      const from = (editor as any).getCursor("from");
      const to = (editor as any).getCursor("to");
      const filePath = this.toAbsolutePath(activeFile.path);
      const fileUrl = `file:///${filePath.replace(/\\/g, "/").replace(/^\//, "")}`;

      return {
        text: selText || "",
        filePath,
        fileUrl,
        selection: {
          start: { line: from.line, character: from.ch },
          end: { line: to.line, character: to.ch },
          isEmpty: !selText || selText.length === 0,
        },
        current: true,
      };
    }

    // Fall back to cached selection from ContextProvider
    const state = this.contextProvider.generateStateJson();
    if (state.selection) {
      const sel = state.selection as any;
      const selFile = state.activeFile as string || "";
      const filePath = selFile ? this.toAbsolutePath(selFile) : "";
      const fileUrl = filePath ? `file:///${filePath.replace(/\\/g, "/").replace(/^\//, "")}` : "";

      return {
        text: sel.text || "",
        filePath,
        fileUrl,
        selection: {
          start: { line: (sel.startLine || 1) - 1, character: sel.startCh || 0 },
          end: { line: (sel.endLine || 1) - 1, character: sel.endCh || 0 },
          isEmpty: !sel.text || sel.text.trim().length === 0,
        },
        current: false,
      };
    }

    // Last resort: report the last known active file with empty selection
    const lastFile = this.lastActiveFile || (this.app.workspace.getActiveFile()?.path);
    if (lastFile) {
      const filePath = this.toAbsolutePath(lastFile);
      const fileUrl = `file:///${filePath.replace(/\\/g, "/").replace(/^\//, "")}`;
      return {
        text: "",
        filePath,
        fileUrl,
        selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, isEmpty: true },
        current: false,
      };
    }

    return null;
  }

  private toolGetDiagnostics(uri?: string): any[] {
    // Obsidian doesn't have LSP-style diagnostics — return empty
    return [];
  }

  private async toolOpenDiff(originalPath: string, newContents: string, tabName: string): Promise<any> {
    // Obsidian doesn't have a native diff view like VS Code.
    // Write the new contents to a temp file and let the user review.
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");

    try {
      // Write new content directly to the file (auto-accept behavior)
      // The user can undo via Obsidian's undo history
      const absPath = path.isAbsolute(originalPath) ? originalPath : this.toAbsolutePath(originalPath);
      fs.writeFileSync(absPath, newContents, "utf-8");

      return {
        status: "SAVED",
        trigger: "auto_accepted",
        message: `Changes applied to ${tabName}. Use Ctrl+Z in Obsidian to undo.`,
      };
    } catch (e: any) {
      return {
        status: "REJECTED",
        trigger: "error",
        message: `Failed to apply diff: ${e.message}`,
      };
    }
  }

  private toolCloseDiff(tabName: string): any {
    return {
      success: true,
      already_closed: true,
      tab_name: tabName,
      message: `No active diff found with tab name "${tabName}" (Obsidian auto-accepts diffs)`,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────

  /** Convert a vault-relative path to an absolute path */
  private toAbsolutePath(relativePath: string): string {
    const path = require("path") as typeof import("path");
    return path.join(this.vaultPath, relativePath);
  }

  /** Read HTTP request body */
  private readBody(req: any): Promise<string | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const limit = 10 * 1024 * 1024; // 10MB

      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf-8"));
      });

      req.on("error", () => resolve(null));
    });
  }

  /** Write the lock file to ~/.copilot/ide/ */
  private async writeLockFile(
    fs: typeof import("fs"),
    path: typeof import("path"),
    os: typeof import("os"),
  ): Promise<void> {
    const crypto = require("crypto") as typeof import("crypto");
    const ideDir = path.join(os.homedir(), ".copilot", "ide");

    try {
      fs.mkdirSync(ideDir, { recursive: true, mode: 0o700 });

      const lockId = crypto.randomUUID();
      this.lockFilePath = path.join(ideDir, `${lockId}.lock`);

      const workspaceFolders = [this.vaultPath];

      const lockData = {
        socketPath: this.socketPath,
        scheme: process.platform === "win32" ? "pipe" : "unix",
        headers: { Authorization: `Nonce ${this.nonce}` },
        pid: process.pid,
        ideName: "Obsidian",
        timestamp: Date.now(),
        workspaceFolders,
        isTrusted: true,
      };

      fs.writeFileSync(this.lockFilePath, JSON.stringify(lockData, null, 2), { mode: 0o600 });
      console.log(`Copilot CLI: Lock file created at ${this.lockFilePath}`);
    } catch (e) {
      console.error("Copilot CLI: Failed to write IDE lock file", e);
    }
  }

  /** Remove stale lock files from dead processes */
  private cleanStaleLockFiles(
    fs: typeof import("fs"),
    path: typeof import("path"),
    os: typeof import("os"),
  ): void {
    const ideDir = path.join(os.homedir(), ".copilot", "ide");

    try {
      const files = fs.readdirSync(ideDir);
      for (const file of files) {
        if (!file.endsWith(".lock")) continue;
        const fullPath = path.join(ideDir, file);

        // Skip our own lock file
        if (fullPath === this.lockFilePath) continue;

        try {
          const content = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
          if (content.pid && !this.isProcessAlive(content.pid)) {
            fs.unlinkSync(fullPath);
            console.log(`Copilot CLI: Removed stale lock file for PID ${content.pid}`);
          }
        } catch {
          // Corrupted lock file — remove it
          try { fs.unlinkSync(fullPath); } catch {}
        }
      }
    } catch {
      // Directory might not exist yet
    }
  }

  /** Check if a process is alive */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
