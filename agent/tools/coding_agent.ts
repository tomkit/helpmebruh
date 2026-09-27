// Hands a coding task to Claude Code or Codex on this Mac, restricted to one
// project folder under the configured root (admin page; default ~/Projects):
// - owner-only: fails closed unless the current message came from the owner
// - the folder must be a project inside the root, and never this assistant's
//   own project (so it can't edit its own restrictions)
// - Claude Code runs in acceptEdits mode with its OS sandbox on (no bypass):
//   edits and shell writes are confined to the folder; credential dirs are unreadable
// - Codex runs in its workspace-write sandbox
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { defineTool } from "eve/tools";
import { z } from "zod";

import { getSettings } from "../lib/settings";

const HOME = homedir();
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? join(HOME, ".local/bin/claude");
const CODEX_BIN = process.env.CODEX_BIN ?? "/opt/homebrew/bin/codex";
const TIMEOUT_MS = 25 * 60_000;
const MAX_OUTPUT = 8_000;

// Home-relative paths coding agents may not read (Claude Code permission rule syntax).
const SENSITIVE = [".ssh", ".aws", ".gnupg", ".config", ".docker", ".kube", ".netrc", "Library"];

const CLAUDE_SETTINGS = JSON.stringify({
  sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
  permissions: {
    deny: [
      ...SENSITIVE.map((p) => `Read(~/${p}/**)`),
      `Read(~/${relative(HOME, process.cwd())}/.env*)`,
    ],
  },
});

const isInside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
};

// Resolves the requested folder and enforces the restrictions above.
async function projectDir(cwd: string, rootSetting: string) {
  const root = await realpath(rootSetting.replace(/^~(?=$|\/)/, HOME));
  const requested = resolve(root, cwd.replace(/^~(?=$|\/)/, HOME));
  const dir = await realpath(requested).catch(() => {
    throw new Error(`${requested} doesn't exist. Pick an existing project folder inside ${root}.`);
  });
  if (!(await stat(dir)).isDirectory()) throw new Error(`${dir} isn't a folder.`);
  if (!isInside(dir, root)) throw new Error(`Coding agents can only work in a project folder inside ${root}.`);
  const self = await realpath(process.cwd());
  if (dir === self || isInside(dir, self) || isInside(self, dir)) {
    throw new Error("Coding agents can't work on the assistant's own project folder.");
  }
  return dir;
}

function run(bin: string, args: string[], cwd: string, signal: AbortSignal) {
  return new Promise<string>((done, fail) => {
    execFile(
      bin,
      args,
      { cwd, signal, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: "1" } },
      (err, stdout, stderr) => (err ? fail(new Error(`${err.message}\n${stderr}`.slice(0, 2_000))) : done(stdout)),
    );
  });
}

export default defineTool({
  description:
    "Delegate a coding task to Claude Code or Codex on the owner's Mac, working in one project folder inside their projects root (default ~/Projects). " +
    "They can read code, edit files and run commands (builds, tests, git) inside that folder only, in a sandbox. " +
    "Use it for work on the owner's projects. Give a complete, self-contained task. Only works when the owner asked. Can take many minutes.",
  inputSchema: z.object({
    task: z.string().min(1).describe("Full instructions for the coding agent."),
    project: z.string().min(1).describe('Project folder name inside the projects root (e.g. "my-app"), or an absolute path inside it.'),
    agent: z.enum(["claude", "codex"]).optional().describe("Omit to use the owner's configured default."),
  }),
  label: {
    start: ({ agent = getSettings().codingAgent.defaultAgent, project }) =>
      `Hand off to ${agent === "codex" ? "Codex" : "Claude Code"} in ${project}`,
  },
  async execute({ task, project, agent: requested }, ctx) {
    const settings = getSettings().codingAgent;
    if (!settings.enabled) throw new Error("The owner has turned coding agents off in the admin page.");
    if (ctx.session.auth.current?.attributes.role !== "owner") {
      throw new Error("Only the owner can use the coding agents. Tell the person you can't do that for them.");
    }
    const agent = requested ?? settings.defaultAgent;
    const dir = await projectDir(project, settings.root);

    if (agent === "claude") {
      const out = await run(
        CLAUDE_BIN,
        ["-p", task, "--output-format", "json", "--permission-mode", "acceptEdits", "--settings", CLAUDE_SETTINGS],
        dir,
        ctx.abortSignal,
      );
      const result = JSON.parse(out) as {
        result?: string;
        is_error?: boolean;
        total_cost_usd?: number;
        permission_denials?: { tool_name: string }[];
      };
      if (result.is_error) throw new Error(`Claude Code failed: ${result.result ?? "unknown error"}`);
      return {
        agent,
        project: dir,
        result: (result.result ?? "").slice(-MAX_OUTPUT),
        blockedActions: result.permission_denials?.map((d) => d.tool_name) ?? [],
        costUsd: result.total_cost_usd,
      };
    }

    const scratch = await mkdtemp(join(tmpdir(), "codex-"));
    try {
      const last = join(scratch, "last-message.txt");
      await run(
        CODEX_BIN,
        ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", dir, "-o", last, task],
        dir,
        ctx.abortSignal,
      );
      return { agent, project: dir, result: (await readFile(last, "utf8")).slice(-MAX_OUTPUT) };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
});
