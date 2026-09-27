// Options the owner can change from the admin page (http://localhost:2000/admin).
// Stored in .state/settings.json and read live by the agent and the bridge
// (bridge/bridge.mjs reads the messaging options from the same file).
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

export const settingsSchema = z.object({
  // Messaging (bridge)
  trigger: z.string().trim().min(1).max(20).default("/bruh"),
  replyPrefix: z.string().trim().min(1).max(8).default("🤖"),
  ack: z.boolean().default(true), // send the reply prefix right away as an acknowledgement
  updateAfterMinutes: z.number().min(0).max(30).default(2), // send it again if still working (0 = off)
  allowedSenders: z.array(z.string().trim().min(1)).default([]),
  // Who besides the owner can trigger it in group chats (DMs always use allowedSenders).
  groupAccess: z.enum(["owner", "allowlist", "everyone"]).default("allowlist"),
  historyMessages: z.number().int().min(0).max(50).default(15),
  replyThreadContext: z.boolean().default(true),
  timeoutMinutes: z.number().int().min(1).max(120).default(30),

  // Models
  modelProvider: z.enum(["chatgpt", "gateway", "anthropic"]).default("chatgpt"),
  model: z.string().trim().min(3).default("gpt-6-luna-fast"),
  imageModel: z.enum(["gemini", "gpt"]).default("gemini"),
  visionModel: z.string().trim().min(3).default("google/gemini-3.8-flash"),

  // Tools
  sandboxInternet: z.boolean().default(true),
  browserProfile: z.string().trim().min(1).default("Default"),
  capabilities: z.object({
    delegationEnabled: z.boolean().default(true),
    inheritEnabled: z.boolean().default(false),
  }).default({ delegationEnabled: true, inheritEnabled: false }),
  codingAgent: z
    .object({
      enabled: z.boolean().default(true),
      root: z.string().trim().min(1).default("~/Projects"),
      defaultAgent: z.enum(["claude", "codex"]).default("claude"),
    })
    .default({ enabled: true, root: "~/Projects", defaultAgent: "claude" }),
});

export type Settings = z.infer<typeof settingsSchema>;

const FILE = join(process.cwd(), ".state", "settings.json");

let cached: { mtimeMs: number; value: Settings } | undefined;

export function getSettings(): Settings {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(FILE).mtimeMs;
  } catch {
    // No file yet: defaults.
  }
  if (cached?.mtimeMs === mtimeMs) return cached.value;
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(FILE, "utf8"));
  } catch {}
  // Existing installs predate modelProvider and used AI Gateway model strings.
  // Preserve that behavior while making ChatGPT subscription auth the default
  // for new installs.
  if (raw && typeof raw === "object" && "model" in raw && !("modelProvider" in raw)) {
    raw = { ...raw, modelProvider: "gateway" };
  }
  const parsed = settingsSchema.safeParse(raw);
  const value = parsed.success ? parsed.data : settingsSchema.parse({});
  cached = { mtimeMs, value };
  return value;
}

// Validates and saves; throws a readable error for invalid input.
export function saveSettings(input: unknown): Settings {
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join(".") || "settings"}: ${i.message}`).join("; "));
  }
  mkdirSync(join(process.cwd(), ".state"), { recursive: true });
  writeFileSync(FILE, `${JSON.stringify(parsed.data, null, 2)}\n`);
  cached = undefined;
  return parsed.data;
}
