import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { defineTool } from "eve/tools";
import { z } from "zod";

import { claude, codex, discoverCapabilities } from "../lib/plugins";

export default defineTool({
  description:
    "Use one installed Codex or Claude Code plugin, skill, or MCP server on the owner's Mac. " +
    "Call discover_capabilities to find its exact runtime and name. SC2 replay requests use Codex sc2-coach@starcraft2-ai. " +
    "A fresh CLI session loads current plugins, skills and MCP configuration, including installs made while Bruh is running. Owner only.",
  inputSchema: z.object({
    runtime: z.enum(["codex", "claude"]),
    capability: z.string().min(1).max(120).describe("Exact installed plugin, skill, or MCP server name."),
    task: z.string().min(1).max(10_000).describe("The owner's complete request and any authorization they gave."),
  }),
  label: { start: ({ runtime, capability }) => `Use ${capability} through ${runtime}` },
  async execute({ runtime, capability, task }, ctx) {
    if (ctx.session.auth.current?.attributes.role !== "owner") throw new Error("Only the owner can use installed capabilities.");
    const found = (await discoverCapabilities()).find(c => c.runtime === runtime && c.id === capability);
    if (!found) throw new Error(`${capability} is not installed for ${runtime}. Refresh Bruh Admin's capability list.`);
    const scratch = await mkdtemp(join(tmpdir(), "bruh-capability-"));
    try {
      const skillPath = found.kind === "skill"
        ? join(runtime === "codex" ? join(homedir(), ".codex") : join(homedir(), ".claude"), "skills", capability, "SKILL.md")
        : null;
      const prompt = `Use the installed ${capability} ${found.kind} and its available tools to complete this request on the owner's Mac. ${skillPath ? `First read and follow ${skillPath}. ` : ""}Do not spend money, send messages, or make external changes unless the owner explicitly authorized them in the request. If a paid action needs confirmation, state its price and ask first. If plugin authentication is required, use its login tool and relay the authorization link or browser instruction. Report what you actually found or did.\n\nOwner request: ${task}`;
      if (runtime === "codex") {
        const last = join(scratch, "answer.txt");
        await codex(["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "-C", homedir(), "-o", last, prompt], 10 * 60_000, ctx.abortSignal);
        return { runtime, capability, result: (await readFile(last, "utf8")).slice(-12_000) };
      }
      const cwd = found.projectPath ?? homedir();
      const settings = JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false } });
      const output = await claude(["-p", prompt, "--output-format", "json", "--no-session-persistence", "--permission-mode", "acceptEdits", "--settings", settings], cwd, 10 * 60_000, ctx.abortSignal);
      const parsed = JSON.parse(output) as { result?: string; is_error?: boolean };
      if (parsed.is_error) throw new Error(parsed.result ?? "Claude Code failed.");
      return { runtime, capability, result: (parsed.result ?? "").slice(-12_000) };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
});
