/**
 * Obsidian Copilot — Setup Script (Windows)
 *
 * Installs node-pty native bindings for the system Node.js.
 * The PTY relay runs under system Node (not Electron), so we need
 * node-pty compiled for the system Node ABI.
 *
 * Usage: node setup.js
 */

const { execSync } = require("child_process");
const { existsSync, mkdirSync, cpSync } = require("fs");
const path = require("path");

const PLUGIN_DIR = __dirname;
const PTY_DIR = path.join(PLUGIN_DIR, "node_modules", "node-pty");

console.log("🔧 Obsidian Copilot — Setup");
console.log("──────────────────────────────");

// Check platform
if (process.platform !== "win32") {
  console.error("❌ This plugin currently supports Windows only.");
  process.exit(1);
}

// Check Node.js version
const nodeVersion = process.versions.node;
const nodeMajor = parseInt(nodeVersion.split(".")[0], 10);
if (nodeMajor < 18) {
  console.error(`❌ Node.js v18+ required (found v${nodeVersion})`);
  process.exit(1);
}
console.log(`✅ Node.js v${nodeVersion} (ABI ${process.versions.modules})`);

// Check if copilot CLI is available
try {
  execSync("copilot --version", { stdio: "pipe" });
  console.log("✅ GitHub Copilot CLI found");
} catch {
  console.warn("⚠️  GitHub Copilot CLI not found in PATH — install it before using the plugin");
}

// Install node-pty
if (existsSync(PTY_DIR)) {
  console.log("ℹ️  node-pty already installed, reinstalling...");
}

console.log("📦 Installing node-pty for system Node.js...");
try {
  execSync("npm install node-pty@^1.0.0 --no-save", {
    cwd: PLUGIN_DIR,
    stdio: "inherit",
    env: { ...process.env, npm_config_target: "" }, // ensure we don't target Electron
  });
  console.log("✅ node-pty installed successfully");
} catch (err) {
  console.error("❌ Failed to install node-pty.");
  console.error("   Make sure you have Visual Studio Build Tools with C++ workload installed.");
  console.error("   Or install windows-build-tools: npm install -g windows-build-tools");
  process.exit(1);
}

// Verify
try {
  const pty = require(path.join(PTY_DIR, "lib", "index.js"));
  console.log("✅ node-pty loads correctly");
} catch (err) {
  console.error("❌ node-pty installed but failed to load:", err.message);
  process.exit(1);
}

console.log("");
console.log("──────────────────────────────");
console.log("✨ Setup complete! Enable the Copilot plugin in Obsidian settings.");
