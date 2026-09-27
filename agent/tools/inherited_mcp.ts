import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { localMcpServer } from "../lib/plugins";
import { getSettings } from "../lib/settings";

export default defineTool({
  description:
    "Call a local stdio MCP server inherited from the owner's Codex or Claude Code setup directly from Bruh, without running another model. " +
    "First use operation=list to see the server's tools and schemas, then operation=call. Owner only. This reads the current server configuration on every call. " +
    "Remote OAuth servers still need delegation. Paid calls with confirm_spend=true are blocked here.",
  inputSchema: z.object({
    runtime: z.enum(["codex", "claude"]),
    server: z.string().min(1).max(120),
    operation: z.enum(["list", "call"]),
    tool: z.string().optional(),
    arguments: z.record(z.string(), z.unknown()).optional(),
  }),
  label: { start: ({ server, operation, tool }) => `${operation === "list" ? "Inspect" : "Use"} ${server}${tool ? `/${tool}` : ""}` },
  async execute(input, ctx) {
    if (ctx.session.auth.current?.attributes.role !== "owner") throw new Error("Only the owner can use inherited MCP servers.");
    if (!getSettings().capabilities.inheritEnabled) throw new Error("Harness inheritance is off in Bruh Admin.");
    const config = await localMcpServer(input.runtime, input.server);
    if (!config) throw new Error(`${input.server} is not an enabled local stdio MCP server. Use delegation if available.`);
    if (input.operation === "call" && (!input.tool || input.arguments?.confirm_spend === true)) {
      throw new Error(input.arguments?.confirm_spend === true ? "Paid MCP calls require a separate owner confirmation." : "Choose a tool name from the server's list.");
    }
    const client = new Client({ name: "helpmebruh", version: "0.1.0" });
    const env = Object.fromEntries(["HOME", "PATH", "USER", "TMPDIR", "LANG"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!])) as Record<string, string>;
    const transport = new StdioClientTransport({ command: config.command, args: config.args, cwd: config.cwd, env: { ...env, ...config.env } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = (async () => {
        await client.connect(transport);
        if (input.operation === "list") {
          const { tools } = await client.listTools();
          return { server: input.server, tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
        }
        const result = await client.callTool({ name: input.tool!, arguments: input.arguments ?? {} });
        return { server: input.server, tool: input.tool, result };
      })();
      return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("MCP server timed out.")), 120_000); })]);
    } finally {
      if (timer) clearTimeout(timer);
      await client.close().catch(() => {});
    }
  },
});
