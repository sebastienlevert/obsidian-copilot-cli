#!/usr/bin/env node
/**
 * PTY Relay — runs in system Node.js (not Electron) so worker_threads work.
 * The Obsidian plugin spawns this script and communicates via stdin/stdout.
 *
 * Protocol:
 *   Plugin -> Relay (stdin):  raw input bytes forwarded to PTY
 *   Relay -> Plugin (stdout): raw PTY output bytes
 *   Resize: Plugin sends JSON on stdin: {"resize":[cols,rows]}\n
 */
const path = require("path");
const { execSync } = require("child_process");

// Resolve plugin directory (where this script lives)
const pluginDir = __dirname;

const cols = parseInt(process.env.COLUMNS || "80", 10);
const rows = parseInt(process.env.LINES || "24", 10);
const cwd = process.env.COPILOT_CWD || process.cwd();
const cmd = process.env.COPILOT_CMD || "copilot --yolo --banner";

const shell = "powershell.exe";
const args = ["-NoLogo", "-NoProfile", "-Command", cmd];
const spawnOpts = {
  name: "xterm-256color",
  cols,
  rows,
  cwd,
  env: { ...process.env, TERM: "xterm-256color" },
};

/**
 * Try to spawn the PTY. If node-pty has an ABI mismatch, auto-rebuild and retry.
 */
function spawnPty() {
  let pty = require("node-pty");
  try {
    return pty.spawn(shell, args, spawnOpts);
  } catch (e) {
    if (e.code === 'ERR_DLOPEN_FAILED' && e.message.includes('NODE_MODULE_VERSION')) {
      process.stderr.write(
        `[pty-relay] node-pty ABI mismatch — rebuilding for Node ${process.version}...\n`
      );
      try {
        execSync("npm install node-pty@^1.0.0 --no-save", {
          cwd: pluginDir,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, npm_config_target: "" },
          timeout: 120000,
        });
        process.stderr.write(`[pty-relay] Rebuild successful!\n`);
        // Clear require cache and retry
        Object.keys(require.cache).forEach((key) => {
          if (key.includes("node-pty")) delete require.cache[key];
        });
        pty = require("node-pty");
        return pty.spawn(shell, args, spawnOpts);
      } catch (rebuildErr) {
        process.stderr.write(
          `[pty-relay] Auto-rebuild failed.\n` +
          `Install Node.js v22 LTS (matching bundled binaries), or install\n` +
          `Visual Studio Build Tools with C++ workload for auto-compilation.\n` +
          `Error: ${rebuildErr.message}\n`
        );
        process.exit(1);
      }
    }
    throw e;
  }
}

const ptyProc = spawnPty();

// PTY output -> stdout (to plugin)
ptyProc.onData((data) => {
  process.stdout.write(data);
});

// PTY exit -> signal and exit
ptyProc.onExit(({ exitCode }) => {
  process.stdout.write(`\r\n[exit:${exitCode}]`);
  process.exit(exitCode);
});

// stdin (from plugin) -> PTY input or resize commands
let inputBuffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  // Check for resize command (JSON on its own line)
  inputBuffer += chunk;
  const lines = inputBuffer.split("\n");
  inputBuffer = lines.pop() || "";

  for (const line of lines) {
    if (line.startsWith('{"resize":')) {
      try {
        const msg = JSON.parse(line);
        if (msg.resize) {
          ptyProc.resize(msg.resize[0], msg.resize[1]);
        }
      } catch {}
    } else {
      ptyProc.write(line + "\n");
    }
  }

  // If there's remaining data without newline, it's regular input
  if (inputBuffer && !inputBuffer.startsWith('{"resize":')) {
    ptyProc.write(inputBuffer);
    inputBuffer = "";
  }
});

process.stdin.on("end", () => {
  ptyProc.kill();
});

// Keep alive
process.stdin.resume();
