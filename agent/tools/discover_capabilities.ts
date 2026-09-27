import { defineTool } from "eve/tools";
import { z } from "zod";

import { discoverCapabilities } from "../lib/plugins";

export default defineTool({
  description:
    "Discover the owner's currently installed Codex and Claude Code plugins, skills, and MCP servers on this Mac. " +
    "Use before delegating to an installed capability. Reads live configuration; no Bruh restart is needed. Owner only.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    if (ctx.session.auth.current?.attributes.role !== "owner") throw new Error("Only the owner can inspect installed capabilities.");
    return { capabilities: await discoverCapabilities() };
  },
});
