import type { CopilotSettings } from "./constants";

/**
 * Manages auto-registration of the Obsidian MCP server in
 * ~/.copilot/mcp-config.json so Copilot CLI can discover it.
 */
export class McpRegistrar {
  private vaultPath: string;
  private pluginDir: string;

  constructor(vaultPath: string, pluginDir: string) {
    this.vaultPath = vaultPath;
    this.pluginDir = pluginDir;
  }

  /** Register the Obsidian MCP server in Copilot CLI config */
  register(): void {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const os = require("os") as typeof import("os");

    const configDir = path.join(os.homedir(), ".copilot");
    const configPath = path.join(configDir, "mcp-config.json");
    const mcpServerPath = path
      .join(this.pluginDir, "obsidian-mcp-server.mjs")
      .replace(/\\/g, "/");
    const statePath = path
      .join(this.vaultPath, ".github", "obsidian-state.json")
      .replace(/\\/g, "/");

    try {
      // Ensure ~/.copilot/ exists
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // Read existing config (or start fresh)
      let config: Record<string, any> = {};
      if (fs.existsSync(configPath)) {
        try {
          config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        } catch {
          // Corrupted file — start fresh but back up
          const backupPath = configPath + ".bak";
          fs.copyFileSync(configPath, backupPath);
          console.warn("Copilot CLI: Backed up corrupted mcp-config.json");
        }
      }

      if (!config.mcpServers) {
        config.mcpServers = {};
      }

      // Set/update the obsidian server entry
      config.mcpServers.obsidian = {
        type: "stdio",
        command: "node",
        args: [mcpServerPath],
        env: {
          OBSIDIAN_VAULT_PATH: this.vaultPath.replace(/\\/g, "/"),
          OBSIDIAN_STATE_FILE: statePath,
        },
        tools: ["*"],
      };

      // Write atomically
      const tmpPath = configPath + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
      fs.renameSync(tmpPath, configPath);

      console.log("Copilot CLI: Registered Obsidian MCP server");
    } catch (e) {
      console.error("Copilot CLI: Failed to register MCP server", e);
    }
  }

  /** Remove the Obsidian MCP server from Copilot CLI config */
  unregister(): void {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const os = require("os") as typeof import("os");

    const configPath = path.join(os.homedir(), ".copilot", "mcp-config.json");

    try {
      if (!fs.existsSync(configPath)) return;

      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (config.mcpServers?.obsidian) {
        delete config.mcpServers.obsidian;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
        console.log("Copilot CLI: Unregistered Obsidian MCP server");
      }
    } catch (e) {
      console.warn("Copilot CLI: Failed to unregister MCP server", e);
    }
  }
}
