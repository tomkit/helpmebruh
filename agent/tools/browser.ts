// Controls a dedicated agent-browser session seeded from the assistant's own
// Chrome profile. The source profile is copied read-only by agent-browser, so
// the owner's other Chrome profiles and live browser windows are never shared.
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineTool } from "eve/tools";
import { z } from "zod";

import { fileRef, putOutboxFile } from "../lib/outbox";
import { getSettings } from "../lib/settings";

const BIN = process.env.AGENT_BROWSER_BIN ?? join(process.cwd(), "node_modules", ".bin", "agent-browser");
const SESSION = process.env.AGENT_BROWSER_SESSION ?? "helpmebruh";
const NAMESPACE = process.env.AGENT_BROWSER_NAMESPACE ?? "helpmebruh-browser";
const CHROME = process.env.AGENT_BROWSER_EXECUTABLE_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MAX_OUTPUT = 20_000;
const TIMEOUT_MS = 90_000;

function run(args: string[], signal: AbortSignal, profile: string) {
  const env = {
    ...process.env,
    AGENT_BROWSER_PROFILE: profile,
    AGENT_BROWSER_SESSION: SESSION,
    AGENT_BROWSER_NAMESPACE: NAMESPACE,
    // Regular Chrome can decrypt this profile's macOS Keychain-protected cookies;
    // Chrome for Testing cannot, even when the profile files are copied correctly.
    AGENT_BROWSER_EXECUTABLE_PATH: CHROME,
    // Preserve browser changes made after the read-only Chrome profile snapshot.
    AGENT_BROWSER_RESTORE: `${SESSION}-${profile.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-chrome`,
    AGENT_BROWSER_IDLE_TIMEOUT_MS: "3600000",
  };
  return new Promise<string>((resolve, reject) => {
    execFile(BIN, args, { env, signal, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}${stderr ? `\n${stderr}` : ""}`.slice(0, 4_000)));
        return;
      }
      resolve((stdout || stderr).trim().slice(0, MAX_OUTPUT));
    });
  });
}

const target = z.string().min(1).describe("An @ref from snapshot, or a CSS selector.");

const webUrl = z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
  message: "Only http:// and https:// URLs are allowed.",
});

const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open"), url: webUrl }),
  z.object({ action: z.literal("snapshot"), interactive: z.boolean().optional().default(true) }),
  z.object({ action: z.literal("click"), target }),
  z.object({ action: z.literal("fill"), target, text: z.string().max(10_000) }),
  z.object({ action: z.literal("type"), target, text: z.string().max(10_000) }),
  z.object({ action: z.literal("press"), key: z.string().min(1).max(100) }),
  z.object({
    action: z.literal("scroll"),
    direction: z.enum(["up", "down", "left", "right"]),
    pixels: z.number().int().min(1).max(10_000).optional(),
  }),
  z.object({ action: z.literal("wait"), target: z.string().min(1).max(500) }),
  z
    .object({
      action: z.literal("get"),
      value: z.enum(["text", "value", "title", "url"]),
      target: target.optional(),
    })
    .refine((input) => ["title", "url"].includes(input.value) || Boolean(input.target), {
      message: "target is required when getting text or value.",
      path: ["target"],
    }),
  z.object({ action: z.literal("screenshot"), fullPage: z.boolean().optional().default(false) }),
  z.object({ action: z.literal("back") }),
  z.object({ action: z.literal("forward") }),
  z.object({ action: z.literal("reload") }),
  z.object({ action: z.literal("tabs") }),
  z.object({ action: z.literal("new_tab"), url: webUrl.optional() }),
  z.object({ action: z.literal("switch_tab"), tab: z.string().regex(/^t\d+$/) }),
  z.object({ action: z.literal("close_tab"), tab: z.string().regex(/^t\d+$/).optional() }),
]);

export default defineTool({
  description:
    "Use the assistant's dedicated Chrome profile to browse and interact with websites. " +
    "Only the owner may use it. Start with open, then snapshot; interact using snapshot @refs and take a fresh snapshot after page changes. " +
    "Use screenshot when visual inspection is needed, then pass its returned ref to look_at_image. " +
    "Before purchases, sending/posting, deleting, accepting invitations, or other consequential actions, ask the owner to confirm as required by your instructions.",
  inputSchema,
  label: { start: ({ action }) => `Use bruh's browser: ${action}` },
  async execute(input, ctx) {
    if (ctx.session.auth.current?.attributes.role !== "owner") {
      throw new Error("Only the owner can use the assistant's Chrome profile.");
    }
    const profile = process.env.AGENT_BROWSER_PROFILE ?? getSettings().browserProfile;

    let args: string[];
    switch (input.action) {
      case "open": args = ["open", input.url]; break;
      case "snapshot": args = ["snapshot", ...(input.interactive ? ["-i"] : []), "-c"]; break;
      case "click": args = ["click", input.target]; break;
      case "fill": args = ["fill", input.target, input.text]; break;
      case "type": args = ["type", input.target, input.text]; break;
      case "press": args = ["press", input.key]; break;
      case "scroll": args = ["scroll", input.direction, ...(input.pixels ? [String(input.pixels)] : [])]; break;
      case "wait": args = ["wait", input.target]; break;
      case "get": args = input.value === "title" || input.value === "url"
        ? ["get", input.value]
        : ["get", input.value, input.target!]; break;
      case "back": args = ["back"]; break;
      case "forward": args = ["forward"]; break;
      case "reload": args = ["reload"]; break;
      case "tabs": args = ["tab"]; break;
      case "new_tab": args = ["tab", "new", ...(input.url ? [input.url] : [])]; break;
      case "switch_tab": args = ["tab", input.tab]; break;
      case "close_tab": args = ["tab", "close", ...(input.tab ? [input.tab] : [])]; break;
      case "screenshot": {
        const path = join(tmpdir(), `helpmebruh-browser-${crypto.randomUUID()}.png`);
        try {
          await run(["screenshot", path, ...(input.fullPage ? ["--full"] : [])], ctx.abortSignal, profile);
          const id = await putOutboxFile(await readFile(path), `browser-${Date.now()}.png`);
          return { ref: fileRef(id), profile };
        } finally {
          await rm(path, { force: true });
        }
      }
    }

    return { profile, result: await run(args, ctx.abortSignal, profile) };
  },
});
