import esbuild from "esbuild";
import process from "process";
import builtinModules from "builtin-modules";
import { copyFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";

const dev = process.argv.includes("--dev");
const banner = `/*
  Obsidian Copilot - GitHub Copilot CLI integration for Obsidian
  https://github.com/sebastienlevert/obsidian-copilot
*/`;

const context = await esbuild.context({
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/*",
    "@lezer/*",
    "node-pty",
    ...builtinModules.map((m) => `node:${m}`),
    ...builtinModules,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: dev ? "inline" : false,
  treeShaking: true,
  outfile: "main.js",
  platform: "node",
  loader: {
    ".css": "text",
  },
  minify: !dev,
});

if (dev) {
  await context.watch();
  console.log("Watching for changes...");
} else {
  await context.rebuild();
  await context.dispose();

  // Build MCP server as a standalone bundle
  await esbuild.build({
    entryPoints: ["src/mcp-server/index.ts"],
    bundle: true,
    format: "esm",
    target: "es2020",
    platform: "node",
    outfile: "obsidian-mcp-server.mjs",
    banner: {
      js: `/* Obsidian MCP Server for GitHub Copilot CLI */`,
    },
    minify: true,
    treeShaking: true,
    external: [...builtinModules.map((m) => `node:${m}`), ...builtinModules],
  });
  console.log("Built obsidian-mcp-server.mjs");

  // Copy styles.css to root (Obsidian loads this separately for global styles)
  copyFileSync("src/styles.css", "styles.css");
  console.log("Copied styles.css to root");
}
