# Skill: Deploy to Obsidian

## Description

Builds the plugin and deploys the output artifacts to the local Obsidian vault's plugin directory so you can immediately test changes by reloading the plugin.

## When to Use

Invoke this skill when the user says any of the following:

- "deploy", "deploy to obsidian", "deploy the plugin"
- "test in obsidian", "try it in obsidian"
- "install locally", "install the plugin"
- "push to vault", "update the plugin"
- "reload", "refresh the plugin"

## Steps

### 1. Build the plugin

Run the production build from the repository root:

```shell
npm run build
```

This produces three artifacts:

| File                       | Description                           |
| -------------------------- | ------------------------------------- |
| `main.js`                  | Bundled plugin code (esbuild output)  |
| `styles.css`               | Global styles (copied by esbuild)     |
| `manifest.json`            | Obsidian plugin manifest (source)     |

The build **must** succeed (exit code 0) before continuing. If it fails, stop and report the errors to the user.

### 2. Locate the Obsidian vault plugin directory

The target directory follows this pattern:

```
<OBSIDIAN_VAULT_PATH>/.obsidian/plugins/copilot-cli/
```

#### Auto-detect the vault path

Before asking the user, try to discover the vault automatically by scanning the user's home directory for folders containing a `.obsidian` subdirectory:

```powershell
# Windows
Get-ChildItem "$env:USERPROFILE" -Directory -Depth 2 | Where-Object { Test-Path (Join-Path $_.FullName ".obsidian") } | Select-Object -ExpandProperty FullName
```

```shell
# macOS / Linux
find "$HOME" -maxdepth 3 -type d -name ".obsidian" 2>/dev/null | sed 's|/.obsidian$||'
```

- If exactly **one** vault is found, use it automatically.
- If **multiple** vaults are found, present the list and ask the user to pick one.
- If **none** are found, ask the user for the path manually.

Once known, remember the vault path for subsequent deploys within the same session.

### 3. Copy artifacts to the plugin directory

Copy these four files from the repository root into the target plugin directory:

```shell
# Create the directory if it doesn't exist
mkdir -p "<OBSIDIAN_VAULT_PATH>/.obsidian/plugins/copilot-cli/"

# Copy artifacts
cp main.js     "<OBSIDIAN_VAULT_PATH>/.obsidian/plugins/copilot-cli/main.js"
cp styles.css  "<OBSIDIAN_VAULT_PATH>/.obsidian/plugins/copilot-cli/styles.css"
cp manifest.json "<OBSIDIAN_VAULT_PATH>/.obsidian/plugins/copilot-cli/manifest.json"
```

Also copy the ConPTY bridge binary if it exists:

```shell
cp conpty-bridge/target/release/conpty-bridge.exe "<OBSIDIAN_VAULT_PATH>/.obsidian/plugins/copilot-cli/conpty-bridge.exe"
```

> **Note:** The `conpty-bridge.exe` copy is optional — it may not exist if the Rust binary hasn't been built locally. Skip without error if missing.

### 4. Confirm deployment

After copying, print a summary:

```
✅ Deployed copilot-cli to <OBSIDIAN_VAULT_PATH>/.obsidian/plugins/copilot-cli/
   - main.js
   - styles.css
   - manifest.json
   - conpty-bridge.exe (if copied)

Reload the plugin in Obsidian: Settings → Community Plugins → Copilot CLI → Reload
Or use Ctrl+P → "Reload app without saving"
```

## Important Notes

- Always run `npm run build` first — never copy stale artifacts.
- Never modify files inside the vault's `.obsidian/` directory beyond the plugin folder.
- The `data.json` file in the plugin directory contains user settings — **never overwrite or delete it**.
- If the vault path doesn't exist or the `.obsidian` folder is missing, alert the user rather than creating it.
