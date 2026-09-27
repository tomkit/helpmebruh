import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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
  direct?: boolean;
};

export type LocalMcpServer = { command: string; args: string[]; cwd?: string; env: Record<string, string> };

export async function localMcpServer(runtime: "codex" | "claude", id: string): Promise<LocalMcpServer | null> {
  if (runtime === "codex") {
    const servers = JSON.parse(await codex(["mcp", "list", "--json"])) as {
      name: string; enabled: boolean; transport: { type: string; command?: string; args?: string[]; cwd?: string; env?: Record<string, string> | null; env_vars?: string[] };
    }[];
    const server = servers.find(s => s.name === id && s.enabled && s.transport.type === "stdio");
    if (!server?.transport.command) return null;
    const t = server.transport;
    const env: Record<string, string> = { ...t.env };
    for (const key of t.env_vars ?? []) if (process.env[key] !== undefined) env[key] = process.env[key];
    return { command: server.transport.command, args: t.args ?? [], cwd: t.cwd, env };
  }
  const config = JSON.parse(await readFile(join(homedir(), ".claude.json"), "utf8").catch(() => "{}")) as {
    mcpServers?: Record<string, { command?: string; args?: string[]; cwd?: string; env?: Record<string, string> }>;
  };
  let server = config.mcpServers?.[id];
  let cwd: string | undefined;
  if (!server) {
    const plugins = JSON.parse(await claude(["plugin", "list", "--json"])) as {
      enabled: boolean; id: string; scope: string; installPath: string; projectPath?: string; mcpServers?: Record<string, { command?: string; args?: string[]; cwd?: string; env?: Record<string, string> }>;
    }[];
    const match = plugins.find(p => p.enabled && p.scope !== "project" && Object.entries(p.mcpServers ?? {}).some(([name, entry]) => `plugin:${p.id}:${name}` === id && entry.command));
    if (match) {
      const name = id.slice(`plugin:${match.id}:`.length);
      server = match.mcpServers?.[name];
      cwd = match.installPath;
    }
  }
  const serverCwd = server?.cwd ? isAbsolute(server.cwd) ? server.cwd : resolve(cwd ?? homedir(), server.cwd) : cwd;
  return server?.command ? { command: server.command, args: server.args ?? [], cwd: serverCwd, env: server.env ?? {} } : null;
}

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
    for (const server of JSON.parse(codexMcp.value) as { name: string; enabled: boolean; transport: { type: string } }[]) {
      if (server.enabled) result.push({ runtime: "codex", kind: "mcp", id: server.name, direct: server.transport.type === "stdio" });
    }
  }
  if (claudePlugins.status === "fulfilled") {
    for (const p of JSON.parse(claudePlugins.value) as { id: string; enabled: boolean; scope: string; projectPath?: string; installPath: string; mcpServers?: Record<string, { command?: string }> }[]) {
      if (p.enabled) {
        result.push({ runtime: "claude", kind: "plugin", id: p.id, scope: p.scope, projectPath: p.projectPath, skills: await skillNames(join(p.installPath, "skills")), mcpServers: Object.keys(p.mcpServers ?? {}) });
        for (const [name, server] of Object.entries(p.mcpServers ?? {})) result.push({ runtime: "claude", kind: "mcp", id: `plugin:${p.id}:${name}`, scope: p.scope, direct: !!server.command && p.scope !== "project" });
      }
    }
  }
  const claudeConfig = JSON.parse(await readFile(join(homedir(), ".claude.json"), "utf8").catch(() => "{}")) as { mcpServers?: Record<string, { command?: string }> };
  for (const [id, server] of Object.entries(claudeConfig.mcpServers ?? {})) result.push({ runtime: "claude", kind: "mcp", id, direct: !!server.command });
  if (claudeMcp.status === "fulfilled") {
    for (const line of claudeMcp.value.split("\n")) {
      const match = line.match(/^(.+?): .+ - ([✔✘!])/);
      if (match && match[2] === "✔" && !result.some(c => c.runtime === "claude" && c.kind === "mcp" && c.id === match[1])) result.push({ runtime: "claude", kind: "mcp", id: match[1], direct: false });
    }
  }
  if (codexSkills.status === "fulfilled") for (const id of codexSkills.value) result.push({ runtime: "codex", kind: "skill", id });
  if (claudeSkills.status === "fulfilled") for (const id of claudeSkills.value) result.push({ runtime: "claude", kind: "skill", id });
  return result;
}

export async function inheritedSkillSources(): Promise<{ id: string; path: string }[]> {
  const [codexPlugins, claudePlugins] = await Promise.allSettled([
    codex(["plugin", "list", "--json"]),
    claude(["plugin", "list", "--json"]),
  ]);
  const sources: { id: string; path: string }[] = [];
  for (const [runtime, root] of [["codex", join(CODEX_HOME, "skills")], ["claude", join(homedir(), ".claude", "skills")]] as const) {
    for (const name of await skillNames(root)) sources.push({ id: `${runtime}_${name}`, path: join(root, name, "SKILL.md") });
  }
  if (codexPlugins.status === "fulfilled") {
    const plugins = (JSON.parse(codexPlugins.value) as { installed?: { name: string; marketplaceName: string; version: string; enabled: boolean }[] }).installed ?? [];
    for (const p of plugins.filter(p => p.enabled)) {
      const root = join(CODEX_HOME, "plugins", "cache", p.marketplaceName, p.name, p.version, "skills");
      for (const name of await skillNames(root)) sources.push({ id: `codex_${p.name}_${name}`, path: join(root, name, "SKILL.md") });
    }
  }
  if (claudePlugins.status === "fulfilled") {
    const plugins = JSON.parse(claudePlugins.value) as { id: string; enabled: boolean; scope: string; installPath: string }[];
    for (const p of plugins.filter(p => p.enabled && p.scope !== "project")) {
      const root = join(p.installPath, "skills");
      for (const name of await skillNames(root)) sources.push({ id: `claude_${p.id}_${name}`, path: join(root, name, "SKILL.md") });
    }
  }
  return sources.slice(0, 100);
}
