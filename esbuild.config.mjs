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
}
