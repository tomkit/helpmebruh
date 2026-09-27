// Local file store shared by the agent and the iMessage channel: files the
// agent creates or generates (served to the bridge for sending) and images
// people send in iMessage (read by the image tools). Files are referenced as
// "file:<id>". The agent runs on the same Mac as the bridge, so a local
// directory is enough.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

const OUTBOX = join(process.cwd(), ".outbox");
const TTL_MS = 24 * 60 * 60 * 1000;

const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".heic": "image/heic", ".svg": "image/svg+xml", ".pdf": "application/pdf",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
  ".wav": "audio/wav", ".csv": "text/csv", ".txt": "text/plain", ".md": "text/markdown",
  ".json": "application/json", ".html": "text/html", ".ics": "text/calendar", ".vcf": "text/vcard",
  ".zip": "application/zip",
};

export const contentTypeFor = (name: string) => TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";

// Stores bytes and returns an opaque id. Also prunes files older than a day.
export async function putOutboxFile(bytes: Uint8Array, filename: string) {
  await mkdir(OUTBOX, { recursive: true });
  for (const f of await readdir(OUTBOX)) {
    const p = join(OUTBOX, f);
    if (Date.now() - (await stat(p)).mtimeMs > TTL_MS) await rm(p, { force: true });
  }
  const id = `${randomUUID()}${extname(filename).toLowerCase()}`;
  await writeFile(join(OUTBOX, id), bytes);
  return id;
}

export async function getOutboxFile(id: string) {
  if (id !== basename(id)) return null; // no path traversal
  try {
    return await readFile(join(OUTBOX, id));
  } catch {
    return null;
  }
}

export const fileRef = (id: string) => `file:${id}`;

// Resolves an image/file reference: "file:<id>" from the store, an http(s)
// URL, or a path in the agent's sandbox.
export async function loadFile(
  ref: string,
  readSandboxFile: (path: string) => Promise<Uint8Array | null>,
): Promise<{ bytes: Uint8Array; mediaType: string; name: string }> {
  if (ref.startsWith("file:")) {
    const id = ref.slice("file:".length);
    const bytes = await getOutboxFile(id);
    if (!bytes) throw new Error(`Unknown file ${ref}`);
    return { bytes, mediaType: contentTypeFor(id), name: id };
  }
  if (/^https?:\/\//.test(ref)) {
    const res = await fetch(ref, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`Couldn't download ${ref}: HTTP ${res.status}`);
    const name = decodeURIComponent(new URL(res.url).pathname.split("/").pop() || "file");
    const mediaType = res.headers.get("content-type")?.split(";")[0].trim() || contentTypeFor(name);
    return { bytes: new Uint8Array(await res.arrayBuffer()), mediaType, name };
  }
  const bytes = await readSandboxFile(ref);
  if (!bytes) throw new Error(`No file at ${ref} in the sandbox.`);
  const name = ref.split("/").pop()!;
  return { bytes, mediaType: contentTypeFor(name), name };
}
