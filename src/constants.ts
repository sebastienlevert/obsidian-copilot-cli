export const VIEW_TYPE_COPILOT = "copilot-terminal-view";
export const ICON_COPILOT = "copilot-icon";

// Simplified GitHub Copilot sparkle icon (SVG path data for Obsidian's addIcon)
export const COPILOT_ICON_SVG = `<path fill="currentColor" d="M48.986 2.154C45.738 3.45 43.16 6.588 42.568 9.895c-.134.744-.21 2.22-.21 4.077v2.908l-1.298.146c-4.75.534-8.712 2.43-11.46 5.484-1.856 2.065-3.05 4.394-3.767 7.346-.418 1.722-.467 2.197-.467 4.528 0 2.337.048 2.803.472 4.537.724 2.976 1.927 5.316 3.772 7.337 2.742 3.004 6.575 4.874 11.206 5.463l1.542.195v2.944c0 2.695.037 3.026.36 4.263.61 2.342 1.58 4.024 3.264 5.662 2.02 1.968 4.28 2.976 7.182 3.207 1.63.13 2.49.013 4.22-.572 2.908-1.984 5.048-4.004 5.828-6.91.318-1.186.363-1.63.363-3.588V53.88h2.32c2.674 0 3.98-.172 5.793-.76 5.36-1.74 8.9-5.756 10.172-11.535.424-1.928.424-5.241 0-7.17-1.272-5.778-4.81-9.794-10.172-11.535-1.804-.586-3.114-.758-5.744-.76l-2.37-.001V19.1c0-2.56-.055-3.093-.414-4.44-.777-2.922-2.456-5.266-4.96-6.924-1.168-.773-3.217-1.5-4.584-1.627-1.52-.14-3.37.01-4.63.46z"/>`;

export type Placement = "right" | "left" | "tab" | "split" | "bottom";

export interface CopilotSettings {
  /** Where to open by default */
  defaultPlacement: Placement;
  /** Auto-open on vault load */
  autoOpen: boolean;
  /** CLI flags passed to copilot */
  copilotFlags: string;
  /** Working directory — "vault" or a custom path */
  workingDirectory: string;
  /** Auto-inject active file context on every message */
  autoInjectContext: boolean;
  /** Always resume the same Copilot session */
  persistentSession: boolean;
  /** Auto-generated session UUID (stored on first use) */
  sessionId: string;
}

export const DEFAULT_SETTINGS: CopilotSettings = {
  defaultPlacement: "right",
  autoOpen: true,
  copilotFlags: "--yolo --banner",
  workingDirectory: "vault",
  autoInjectContext: true,
  persistentSession: true,
  sessionId: "",
};
