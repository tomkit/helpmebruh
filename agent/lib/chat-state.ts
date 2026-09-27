// Small per-chat state the iMessage channel keeps on disk:
// - images: the last few images that went through the agent in this chat
//   (sent by it, or sent to it with a request), so "the photo" can be resolved
// - results: finished replies by bridge message id, so a message the bridge
//   retries after a restart gets its saved reply instead of running again
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ChatImageRef = { ref: string; filename: string; at: string; from: string; note: string };
export type SavedResult = { reply: string; attachments: unknown[]; at: string };

type ChatState = { images: ChatImageRef[]; results: Record<string, SavedResult> };

const DIR = join(process.cwd(), ".state");
const FILE = join(DIR, "chats.json");
const MAX_IMAGES = 10;
const RESULT_TTL_MS = 24 * 60 * 60 * 1000;

let chats: Record<string, ChatState> | undefined;

function load() {
  if (!chats) {
    try {
      chats = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, ChatState>;
    } catch {
      chats = {};
    }
  }
  return chats;
}

function save() {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(chats));
}

function chat(chatId: string) {
  const all = load();
  return (all[chatId] ??= { images: [], results: {} });
}

export const recentImages = (chatId: string) => chat(chatId).images;

export function rememberImages(chatId: string, images: ChatImageRef[]) {
  if (!images.length) return;
  const state = chat(chatId);
  state.images = [...images.reverse(), ...state.images].slice(0, MAX_IMAGES);
  save();
}

export const savedResult = (chatId: string, messageId: string) => chat(chatId).results[messageId];

export function saveResult(chatId: string, messageId: string, result: SavedResult) {
  const state = chat(chatId);
  const cutoff = Date.now() - RESULT_TTL_MS;
  for (const [id, r] of Object.entries(state.results)) if (Date.parse(r.at) < cutoff) delete state.results[id];
  state.results[messageId] = result;
  save();
}
