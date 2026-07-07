/**
 * Resolves the GitHub Copilot CLI executable and the Node.js environment it
 * needs to run.
 *
 * When Obsidian is launched from the GUI (not a terminal), the inherited PATH
 * often does NOT include the npm global bin directory — especially on machines
 * that manage Node via nvm / nvm-windows or a non-standard install. In that
 * case a bare `copilot` command fails with "not recognized". To make launching
 * robust we:
 *   1. Try to locate the `copilot` launcher (copilot.cmd / .ps1 / .exe / bin)
 *      in the common Node / npm-global locations.
 *   2. Collect the directories that contain `node` so the copilot launcher
 *      (which shells out to node) can find it. These are prepended to PATH.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface ResolvedCopilot {
  /** Absolute path to the copilot launcher, or "copilot" as a PATH fallback. */
  command: string;
  /** Whether an absolute path was resolved (vs. falling back to PATH lookup). */
  resolved: boolean;
  /** Directories to prepend to PATH so `node`/`copilot` resolve. */
  extraPathDirs: string[];
}

const isWindows = process.platform === "win32";

/** Candidate launcher file names for the copilot CLI, per platform. */
function copilotFileNames(): string[] {
  return isWindows
    ? ["copilot.cmd", "copilot.ps1", "copilot.exe", "copilot"]
    : ["copilot"];
}

/** Candidate node executable names, per platform. */
function nodeFileNames(): string[] {
  return isWindows ? ["node.exe", "node"] : ["node"];
}

function existsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Return the immediate subdirectories of `dir`, newest (by name) first. */
function versionSubdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Return subdirectories of `dir` sorted by modification time, newest first. */
function newestDirsByMtime(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => path.join(dir, e.name))
      .map((p) => {
        let mtime = 0;
        try {
          mtime = fs.statSync(p).mtimeMs;
        } catch {
          // broken junction / removed target — keep at the bottom
        }
        return { p, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .map((x) => x.p);
  } catch {
    return [];
  }
}

/**
 * fnm (Fast Node Manager) installs Node under <fnmDir>/node-versions/<v>/
 * installation and injects a per-shell shim directory (multishell) into PATH
 * only inside the active shell. When Obsidian is launched from the GUI, that
 * shim dir is NOT on PATH, so we resolve fnm's stable installation dirs (and,
 * as a fallback, the per-session multishell dirs) directly.
 */
function fnmDirs(): string[] {
  const dirs: string[] = [];
  const env = process.env;
  const home = os.homedir();
  const push = (d: string | undefined | null) => {
    if (d && !dirs.includes(d)) dirs.push(d);
  };
  // On Windows the shims/node live directly in the installation dir; on POSIX
  // under installation/bin (or <multishell>/bin).
  const binOf = (d: string) => (isWindows ? d : path.join(d, "bin"));

  // 1. Active multishell, if `fnm env` happened to be inherited (most precise).
  if (env.FNM_MULTISHELL_PATH) push(binOf(env.FNM_MULTISHELL_PATH));

  // 2. Candidate fnm root directories.
  const roots: string[] = [];
  const pushRoot = (d: string | undefined | null) => {
    if (d && !roots.includes(d)) roots.push(d);
  };
  pushRoot(env.FNM_DIR);
  if (isWindows) {
    pushRoot(env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "fnm"));
    pushRoot(env.APPDATA && path.join(env.APPDATA, "fnm"));
  } else {
    pushRoot(env.XDG_DATA_HOME && path.join(env.XDG_DATA_HOME, "fnm"));
    pushRoot(path.join(home, ".local", "share", "fnm"));
  }
  pushRoot(path.join(home, ".fnm"));

  for (const root of roots) {
    // The `default` alias points at the user's default Node version.
    push(binOf(path.join(root, "aliases", "default", "installation")));
    push(binOf(path.join(root, "aliases", "default")));
    // All installed versions, newest first.
    for (const v of versionSubdirs(path.join(root, "node-versions"))) {
      push(binOf(path.join(v, "installation")));
    }
  }

  // 3. Per-session multishell dirs (symlinks to an installation). Names are
  //    <pid>_<timestamp> and change per session and accumulate over time, so
  //    only consider the few most-recently-used to keep PATH small.
  const multishellRoots = isWindows
    ? [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "fnm_multishells")]
    : [
        env.XDG_STATE_HOME && path.join(env.XDG_STATE_HOME, "fnm_multishells"),
        path.join(home, ".local", "state", "fnm_multishells"),
      ];
  for (const mr of multishellRoots) {
    if (!mr) continue;
    for (const d of newestDirsByMtime(mr).slice(0, 5)) push(binOf(d));
  }

  return dirs;
}

/** Read a `prefix=` line from the user's ~/.npmrc, if present. */
function npmrcPrefix(): string | undefined {
  try {
    const rc = fs.readFileSync(path.join(os.homedir(), ".npmrc"), "utf-8");
    for (const line of rc.split(/\r?\n/)) {
      const m = /^\s*prefix\s*=\s*(.+?)\s*$/.exec(line);
      if (m) return m[1].replace(/^["']|["']$/g, "");
    }
  } catch {
    // no ~/.npmrc — ignore
  }
  return undefined;
}

/** Given an npm global prefix, return the dir that holds the CLI shims. */
function prefixBinDirs(prefix: string): string[] {
  // On Windows the shims (copilot.cmd) live directly in the prefix; on POSIX
  // they live in <prefix>/bin.
  return isWindows ? [prefix] : [path.join(prefix, "bin")];
}

/**
 * Build the ordered list of directories that may contain `copilot`/`node`.
 * Order matters: earlier entries win.
 */
function candidateDirs(): string[] {
  const dirs: string[] = [];
  const env = process.env;
  const home = os.homedir();

  const push = (d: string | undefined | null) => {
    if (d && !dirs.includes(d)) dirs.push(d);
  };

  // Custom npm global prefixes take precedence — these are where a globally
  // installed `copilot` actually lands when the user overrides the prefix.
  for (const prefix of [env.npm_config_prefix, npmrcPrefix()]) {
    if (prefix) for (const b of prefixBinDirs(prefix)) push(b);
  }

  // fnm (Fast Node Manager) — stable installation dirs + per-session shims.
  for (const d of fnmDirs()) push(d);

  if (isWindows) {
    // nvm-windows exposes the active version via NVM_SYMLINK (usually
    // C:\Program Files\nodejs). node + globally-installed .cmd shims live here.
    push(env.NVM_SYMLINK);
    push(env.ProgramFiles && path.join(env.ProgramFiles, "nodejs"));
    push(env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"] as string, "nodejs"));
    // Standard npm global prefix for the per-user Node installer.
    push(env.APPDATA && path.join(env.APPDATA, "npm"));
    push(path.join(home, "AppData", "Roaming", "npm"));
    // nvm-windows install root — scan each installed version directory.
    for (const root of [env.NVM_HOME, path.join(home, "AppData", "Roaming", "nvm")]) {
      if (root) for (const v of versionSubdirs(root)) push(v);
    }
  } else {
    // POSIX: nvm keeps versions under ~/.nvm/versions/node/<ver>/bin.
    const nvmDir = env.NVM_DIR || path.join(home, ".nvm");
    for (const v of versionSubdirs(path.join(nvmDir, "versions", "node"))) {
      push(path.join(v, "bin"));
    }
    // Common global prefixes.
    push(env.npm_config_prefix && path.join(env.npm_config_prefix as string, "bin"));
    push(path.join(home, ".npm-global", "bin"));
    push(path.join(home, ".local", "bin"));
    push("/usr/local/bin");
    push("/usr/bin");
    push("/opt/homebrew/bin");
  }

  return dirs;
}

/**
 * Locate the copilot launcher and the node directories to add to PATH.
 *
 * @param override Optional user-configured absolute path to the copilot
 *                 executable (takes precedence over auto-detection).
 */
export function resolveCopilot(override?: string): ResolvedCopilot {
  const dirs = candidateDirs();

  // Directories that actually contain a node binary — these must be on PATH so
  // the copilot launcher can spawn node.
  const nodeDirs = dirs.filter((d) =>
    nodeFileNames().some((n) => existsFile(path.join(d, n)))
  );

  // 1. Explicit user override wins if it points at a real file.
  if (override && override.trim()) {
    const abs = override.trim();
    if (existsFile(abs)) {
      const dir = path.dirname(abs);
      return {
        command: abs,
        resolved: true,
        extraPathDirs: dedupe([dir, ...nodeDirs]),
      };
    }
  }

  // 2. Auto-detect the copilot launcher in the candidate directories.
  for (const dir of dirs) {
    for (const name of copilotFileNames()) {
      const full = path.join(dir, name);
      if (existsFile(full)) {
        return {
          command: full,
          resolved: true,
          extraPathDirs: dedupe([dir, ...nodeDirs]),
        };
      }
    }
  }

  // 3. Fall back to PATH resolution, but still surface any node dirs we found
  //    so augmenting PATH may let a bare `copilot` resolve.
  return { command: "copilot", resolved: false, extraPathDirs: dedupe(nodeDirs) };
}

function dedupe(items: string[]): string[] {
  return items.filter((v, i) => items.indexOf(v) === i);
}
