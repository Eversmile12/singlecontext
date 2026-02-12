import { dirname, join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

type JsonObject = Record<string, unknown>;

interface SetupOptions {
  cursor?: boolean;
  claude?: boolean;
  claudeCli?: boolean;
  codex?: boolean;
}

interface McpServerEntry {
  command: string;
  args: string[];
}

type SetupTarget = "cursor" | "claude" | "claude-cli" | "codex";

interface AutoSetupResult {
  detected: SetupTarget[];
  configured: SetupTarget[];
  failed: Array<{ target: SetupTarget; reason: string }>;
}

/**
 * Configure MCP client files for Cursor or Claude.
 */
export function setupCommand(options: SetupOptions): void {
  const selected =
    Number(Boolean(options.cursor)) +
    Number(Boolean(options.claude)) +
    Number(Boolean(options.claudeCli)) +
    Number(Boolean(options.codex));
  if (selected !== 1) {
    console.error(
      "Choose exactly one target: `--cursor`, `--claude`, `--claude-cli`, or `--codex`."
    );
    process.exit(1);
  }

  const target: SetupTarget = options.cursor
    ? "cursor"
    : options.claude
      ? "claude"
      : options.claudeCli
        ? "claude-cli"
        : "codex";
  setupTarget(target);

  const targetPath = getConfigPath(target);
  console.log(`Configured MCP server in: ${targetPath}`);
  console.log("Restart your client app so it reloads MCP configuration.");
}

export function autoSetupDetectedClients(): AutoSetupResult {
  const detected = detectInstalledClients();
  const configured: SetupTarget[] = [];
  const failed: Array<{ target: SetupTarget; reason: string }> = [];

  for (const target of detected) {
    try {
      setupTarget(target);
      configured.push(target);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed.push({ target, reason });
    }
  }

  return { detected, configured, failed };
}

function getCursorConfigPath(): string {
  return join(homedir(), ".cursor", "mcp.json");
}

function getClaudeConfigPath(): string {
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json"
    );
  }
  if (process.platform === "win32") {
    return join(homedir(), "AppData", "Roaming", "Claude", "claude_desktop_config.json");
  }
  return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}

function getCodexConfigPath(): string {
  return join(homedir(), ".codex", "config.toml");
}

function getClaudeCliConfigPath(): string {
  return join(homedir(), ".claude.json");
}

function getConfigPath(target: SetupTarget): string {
  if (target === "cursor") return getCursorConfigPath();
  if (target === "claude") return getClaudeConfigPath();
  if (target === "claude-cli") return getClaudeCliConfigPath();
  return getCodexConfigPath();
}

function setupTarget(target: SetupTarget): void {
  if (target === "codex") {
    updateCodexConfig(getCodexConfigPath());
    return;
  }
  updateMcpConfig(getConfigPath(target));
}

function detectInstalledClients(): SetupTarget[] {
  const detected: SetupTarget[] = [];

  if (existsSync(join(homedir(), ".cursor"))) {
    detected.push("cursor");
  }

  if (existsSync(dirname(getClaudeConfigPath()))) {
    detected.push("claude");
  }

  if (existsSync(getClaudeCliConfigPath()) || commandExists("claude") || commandExists("claude-code")) {
    detected.push("claude-cli");
  }

  if (existsSync(join(homedir(), ".codex")) || commandExists("codex")) {
    detected.push("codex");
  }

  return detected;
}

function commandExists(command: string): boolean {
  const cmd = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(cmd, [command], { stdio: "ignore" });
  return result.status === 0;
}

function updateMcpConfig(configPath: string): void {
  const root = readJsonObject(configPath);

  const mcpServers =
    isJsonObject(root.mcpServers) ? { ...root.mcpServers } : ({} as JsonObject);

  const serverEntry: McpServerEntry = {
    // Use current Node executable path to avoid PATH issues.
    command: process.execPath,
    args: [fileURLToPath(new URL("../index.js", import.meta.url)), "serve"],
  };

  mcpServers.sharme = serverEntry;

  const updated: JsonObject = {
    ...root,
    mcpServers,
  };

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
}

function updateCodexConfig(configPath: string): void {
  const command = process.execPath;
  const args = [fileURLToPath(new URL("../index.js", import.meta.url)), "serve"];

  const sharmeSection = [
    "[mcp_servers.sharme]",
    `command = ${toTomlString(command)}`,
    `args = [${args.map((arg) => toTomlString(arg)).join(", ")}]`,
  ].join("\n");

  mkdirSync(dirname(configPath), { recursive: true });

  const existing = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
  const normalized = existing.replace(/\r\n/g, "\n").trimEnd();
  const sectionRegex = /^\[mcp_servers\.sharme\]\n[\s\S]*?(?=^\[[^\]]+\]\n?|$)/m;

  const nextContent = sectionRegex.test(normalized)
    ? normalized.replace(sectionRegex, sharmeSection)
    : normalized === ""
      ? sharmeSection
      : `${normalized}\n\n${sharmeSection}`;

  writeFileSync(configPath, `${nextContent}\n`, "utf-8");
}

function toTomlString(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function readJsonObject(path: string): JsonObject {
  if (!existsSync(path)) {
    return {};
  }

  const raw = readFileSync(path, "utf-8").trim();
  if (raw === "") {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isJsonObject(parsed)) {
      throw new Error("root value is not a JSON object");
    }
    return parsed;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in ${path}: ${reason}`);
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
