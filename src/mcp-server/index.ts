#!/usr/bin/env node
/**
 * Obsidian MCP Server for GitHub Copilot CLI
 *
 * A stdio-based MCP server that exposes Obsidian IDE state to Copilot CLI
 * using standard ide_* tool names. Reads vault files from disk and IDE state
 * from obsidian-state.json written by the Obsidian plugin.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import * as fs from "fs";
import * as path from "path";

// ── Configuration from environment ──────────────────────────────────────────

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || "";
const STATE_FILE =
  process.env.OBSIDIAN_STATE_FILE ||
  path.join(VAULT_PATH, ".github", "obsidian-state.json");

interface ObsidianState {
  activeFile: string | null;
  selection: {
    text: string;
    startLine: number;
    startCh: number;
    endLine: number;
    endCh: number;
  } | null;
  openFiles: string[];
  vaultPath: string;
  metadata: {
    frontmatter?: Record<string, unknown>;
    tags?: string[];
    outgoingLinks?: string[];
  } | null;
  timestamp: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function readState(): ObsidianState {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    return JSON.parse(raw) as ObsidianState;
  } catch {
    return {
      activeFile: null,
      selection: null,
      openFiles: [],
      vaultPath: VAULT_PATH,
      metadata: null,
      timestamp: 0,
    };
  }
}

function resolveVaultPath(filePath: string): string {
  // Prevent path traversal outside the vault
  const resolved = path.resolve(VAULT_PATH, filePath);
  if (!resolved.startsWith(path.resolve(VAULT_PATH))) {
    throw new Error("Path traversal outside vault is not allowed");
  }
  return resolved;
}

function listDirRecursive(
  dirPath: string,
  prefix: string,
  depth: number,
  maxDepth: number,
  maxEntries: number,
  count: { value: number }
): string[] {
  if (depth > maxDepth || count.value >= maxEntries) return [];
  const lines: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  // Sort: folders first, then alphabetical
  entries.sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1;
    const bDir = b.isDirectory() ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name);
  });

  for (let i = 0; i < entries.length && count.value < maxEntries; i++) {
    const entry = entries[i];
    if (entry.name.startsWith(".")) continue;

    const isLast = i === entries.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const nextPrefix = isLast ? prefix + "    " : prefix + "│   ";

    count.value++;
    if (entry.isDirectory()) {
      lines.push(`${prefix}${connector}${entry.name}/`);
      lines.push(
        ...listDirRecursive(
          path.join(dirPath, entry.name),
          nextPrefix,
          depth + 1,
          maxDepth,
          maxEntries,
          count
        )
      );
    } else {
      lines.push(`${prefix}${connector}${entry.name}`);
    }
  }

  return lines;
}

function searchFiles(
  dirPath: string,
  query: string,
  maxResults: number,
  results: { path: string; line?: number; text?: string }[]
): void {
  if (results.length >= maxResults) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  const queryLower = query.toLowerCase();

  for (const entry of entries) {
    if (results.length >= maxResults) return;
    if (entry.name.startsWith(".")) continue;

    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(VAULT_PATH, fullPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      searchFiles(fullPath, query, maxResults, results);
    } else {
      // Match filename
      if (entry.name.toLowerCase().includes(queryLower)) {
        results.push({ path: relativePath });
      }
      // Match content for text files
      if (
        results.length < maxResults &&
        /\.(md|txt|json|yaml|yml|csv|html|xml|js|ts|py|sh|css)$/i.test(
          entry.name
        )
      ) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= maxResults) break;
            if (lines[i].toLowerCase().includes(queryLower)) {
              results.push({
                path: relativePath,
                line: i + 1,
                text: lines[i].trim().slice(0, 200),
              });
            }
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }
}

// ── MCP Server Setup ────────────────────────────────────────────────────────

const server = new Server(
  { name: "obsidian", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// List available tools
server.setRequestHandler(
  { method: "tools/list" } as any,
  async () => ({
    tools: [
      {
        name: "ide_get_selection",
        description:
          "Get the currently selected text in the Obsidian editor, including line/character positions.",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "ide_get_open_files",
        description:
          "List all files currently open as tabs in Obsidian, with the active file marked.",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "ide_read_file",
        description: "Read the content of a specific file in the Obsidian vault.",
        inputSchema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description:
                "Relative path to the file within the vault (e.g., 'notes/daily/2026-04-22.md')",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "ide_get_diagnostics",
        description:
          "Get metadata for the active file: frontmatter, tags, and outgoing links.",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "ide_search_text",
        description:
          "Search for text in vault file names and content. Returns matching files and lines.",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: {
              type: "string",
              description: "Text to search for (case-insensitive)",
            },
            maxResults: {
              type: "number",
              description: "Maximum number of results to return (default: 20)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "ide_list_dir",
        description:
          "List the vault directory structure as a tree. Optionally specify a subdirectory.",
        inputSchema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description:
                "Relative path to list (default: vault root). E.g., 'notes/projects'",
            },
            maxDepth: {
              type: "number",
              description: "Maximum directory depth (default: 3)",
            },
          },
        },
      },
    ],
  })
);

// Handle tool calls
server.setRequestHandler(
  { method: "tools/call" } as any,
  async (request: any) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "ide_get_selection": {
        const state = readState();
        if (!state.selection) {
          return {
            content: [
              {
                type: "text",
                text: "No text is currently selected in the editor.",
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  activeFile: state.activeFile,
                  selection: state.selection,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "ide_get_open_files": {
        const state = readState();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  activeFile: state.activeFile,
                  openFiles: state.openFiles,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "ide_read_file": {
        const filePath = args?.path;
        if (!filePath) {
          return {
            content: [
              { type: "text", text: "Error: 'path' parameter is required." },
            ],
            isError: true,
          };
        }
        try {
          const resolved = resolveVaultPath(filePath);
          const content = fs.readFileSync(resolved, "utf-8");
          return {
            content: [
              {
                type: "text",
                text: content.length > 100000
                  ? content.slice(0, 100000) +
                    `\n\n[Truncated at 100,000 characters. Full size: ${content.length}]`
                  : content,
              },
            ],
          };
        } catch (e: any) {
          return {
            content: [
              {
                type: "text",
                text: `Error reading file '${filePath}': ${e.message}`,
              },
            ],
            isError: true,
          };
        }
      }

      case "ide_get_diagnostics": {
        const state = readState();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  activeFile: state.activeFile,
                  metadata: state.metadata,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "ide_search_text": {
        const query = args?.query;
        if (!query) {
          return {
            content: [
              { type: "text", text: "Error: 'query' parameter is required." },
            ],
            isError: true,
          };
        }
        const maxResults = args?.maxResults || 20;
        const results: { path: string; line?: number; text?: string }[] = [];
        searchFiles(VAULT_PATH, query, maxResults, results);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ query, resultCount: results.length, results }, null, 2),
            },
          ],
        };
      }

      case "ide_list_dir": {
        const dirPath = args?.path || "";
        const maxDepth = args?.maxDepth || 3;
        const resolved = resolveVaultPath(dirPath);

        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
          return {
            content: [
              {
                type: "text",
                text: `Error: '${dirPath || "/"}' is not a valid directory.`,
              },
            ],
            isError: true,
          };
        }

        const count = { value: 0 };
        const lines = [
          (dirPath || path.basename(VAULT_PATH)) + "/",
          ...listDirRecursive(resolved, "", 0, maxDepth, 500, count),
        ];

        if (count.value >= 500) {
          lines.push("... (truncated at 500 entries)");
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }

      default:
        return {
          content: [
            { type: "text", text: `Unknown tool: ${name}` },
          ],
          isError: true,
        };
    }
  }
);

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
  if (!VAULT_PATH) {
    process.stderr.write(
      "Error: OBSIDIAN_VAULT_PATH environment variable is not set.\n"
    );
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  process.stderr.write(`Obsidian MCP server error: ${e}\n`);
  process.exit(1);
});
