import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const CODEX_BIN = process.env.CODEX_BIN ?? "/opt/homebrew/bin/codex";
export const CODEX_HOME = join(homedir(), ".codex");
export const CLAUDE_BIN = process.env.CLAUDE_BIN ?? join(homedir(), ".local/bin/claude");

export function runCli(bin: string, args: string[], cwd = homedir(), timeout = 90_000, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, {
      cwd,
      env: { ...process.env, CODEX_HOME, CI: "1" },
      timeout,
      signal,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().slice(0, 1200)));
      else resolve(stdout);
    });
  });
}

export const codex = (args: string[], timeout = 90_000, signal?: AbortSignal) =>
  runCli(CODEX_BIN, args, homedir(), timeout, signal);
export const claude = (args: string[], cwd = homedir(), timeout = 90_000, signal?: AbortSignal) =>
  runCli(CLAUDE_BIN, args, cwd, timeout, signal);

export function validMarketplace(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z\d][\w.-]*\/[A-Za-z\d][\w.-]*$/.test(value) && value.length <= 120;
}

export function validPlugin(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z\d][\w.-]*@[A-Za-z\d][\w.-]*$/.test(value) && value.length <= 120;
}

export async function installedPlugins(): Promise<{ pluginId: string; enabled: boolean }[]> {
  const result = JSON.parse(await codex(["plugin", "list", "--json"])) as {
    installed?: { pluginId: string; enabled: boolean }[];
  };
  return result.installed ?? [];
}

export type Capability = {
  runtime: "codex" | "claude";
  kind: "plugin" | "skill" | "mcp";
  id: string;
  scope?: string;
  projectPath?: string;
  skills?: string[];
  mcpServers?: string[];
};

async function skillNames(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if ((await readdir(join(dir, entry.name)).catch((): string[] => [])).includes("SKILL.md")) names.push(entry.name);
  }
  return names;
}

export async function discoverCapabilities(): Promise<Capability[]> {
  const [codexPlugins, codexMcp, claudePlugins, claudeMcp, codexSkills, claudeSkills] = await Promise.allSettled([
    codex(["plugin", "list", "--json"]),
    codex(["mcp", "list", "--json"]),
    claude(["plugin", "list", "--json"]),
    claude(["mcp", "list"], homedir(), 20_000),
    skillNames(join(CODEX_HOME, "skills")),
    skillNames(join(homedir(), ".claude", "skills")),
  ]);
  const result: Capability[] = [];
  if (codexPlugins.status === "fulfilled") {
    const installed = (JSON.parse(codexPlugins.value) as { installed?: { pluginId: string; enabled: boolean; name: string; marketplaceName: string; version: string }[] }).installed ?? [];
    for (const p of installed.filter(p => p.enabled)) {
      const root = join(CODEX_HOME, "plugins", "cache", p.marketplaceName, p.name, p.version);
      result.push({ runtime: "codex", kind: "plugin", id: p.pluginId, skills: await skillNames(join(root, "skills")) });
    }
  }
  if (codexMcp.status === "fulfilled") {
    for (const server of JSON.parse(codexMcp.value) as { name: string; enabled: boolean }[]) {
      if (server.enabled) result.push({ runtime: "codex", kind: "mcp", id: server.name });
    }
  }
  if (claudePlugins.status === "fulfilled") {
    for (const p of JSON.parse(claudePlugins.value) as { id: string; enabled: boolean; scope: string; projectPath?: string; installPath: string; mcpServers?: Record<string, unknown> }[]) {
      if (p.enabled) result.push({ runtime: "claude", kind: "plugin", id: p.id, scope: p.scope, projectPath: p.projectPath, skills: await skillNames(join(p.installPath, "skills")), mcpServers: Object.keys(p.mcpServers ?? {}) });
    }
  }
  if (claudeMcp.status === "fulfilled") {
    for (const line of claudeMcp.value.split("\n")) {
      const match = line.match(/^(.+?): .+ - ([✔✘!])/);
      if (match && match[2] === "✔") result.push({ runtime: "claude", kind: "mcp", id: match[1] });
    }
  }
  if (codexSkills.status === "fulfilled") for (const id of codexSkills.value) result.push({ runtime: "codex", kind: "skill", id });
  if (claudeSkills.status === "fulfilled") for (const id of claudeSkills.value) result.push({ runtime: "claude", kind: "skill", id });
  return result;
}
