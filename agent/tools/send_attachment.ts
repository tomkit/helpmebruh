// Queues a file (image, video, PDF, ...) to be sent into the iMessage chat
// along with the text reply. The iMessage channel collects successful calls
// from the turn's events and hands them to the bridge, which downloads and
// sends each file.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { contentTypeFor, fileRef, putOutboxFile } from "../lib/outbox";

const MAX_BYTES = 50 * 1024 * 1024;

// Resolves a web page URL to its preview image (og:image / twitter:image).
async function previewImage(pageUrl: string, html: string) {
  const match =
    html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)(?::url)?["'][^>]*content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
  return match ? new URL(match[1].replace(/&amp;/g, "&"), pageUrl).toString() : null;
}

async function probe(url: string) {
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Couldn't download ${url}: HTTP ${res.status}`);
  return res;
}

export default defineTool({
  description:
    "Send a file (image, GIF, video, audio, PDF, ...) into the current iMessage chat along with your reply. " +
    "Pass either `url` (a direct public URL; a web page URL sends the page's preview image) or `path` " +
    "(a file you created in your sandbox, e.g. with write_file). " +
    "Call once per file; don't paste the URL in your text reply as well.",
  inputSchema: z
    .object({
      url: z.string().url().optional().describe("Direct URL of the file, or a web page whose preview image should be sent."),
      path: z.string().optional().describe("Path of a file in your sandbox, e.g. report.csv or /workspace/chart.svg"),
      filename: z.string().optional().describe("File name to show in iMessage, e.g. doomsday-poster.jpg"),
    })
    .refine((i) => Boolean(i.url) !== Boolean(i.path), { message: "Pass exactly one of url or path." }),
  label: { start: ({ url, path }) => `Attach ${path ?? (url ? new URL(url).hostname : "file")}` },
  async execute({ url, path, filename }, ctx) {
    if (path) {
      const sandbox = await ctx.getSandbox();
      const bytes = await sandbox.readBinaryFile({ path });
      if (!bytes) throw new Error(`No file at ${path} in the sandbox.`);
      if (bytes.byteLength > MAX_BYTES) throw new Error("File is too large for iMessage.");
      const name = filename ?? path.split("/").pop()!;
      const id = await putOutboxFile(bytes, name);
      return { queued: true, fileId: id, ref: fileRef(id), filename: name, contentType: contentTypeFor(name) };
    }

    let res = await probe(url!);
    let type = res.headers.get("content-type")?.split(";")[0].trim() ?? "";

    if (type === "text/html") {
      const image = await previewImage(res.url, await res.text());
      if (!image) throw new Error(`${url} is a web page with no preview image. Find a direct file URL instead.`);
      res = await probe(image);
      type = res.headers.get("content-type")?.split(";")[0].trim() ?? "";
    }
    if (type.startsWith("text/html")) throw new Error(`${res.url} is a web page, not a file.`);

    const size = Number(res.headers.get("content-length") ?? 0);
    await res.body?.cancel();
    if (size > MAX_BYTES) throw new Error(`File is too large for iMessage (${Math.round(size / 1e6)} MB).`);

    const finalUrl = res.url;
    const name = filename ?? decodeURIComponent(new URL(finalUrl).pathname.split("/").pop() || "attachment");
    return { queued: true, url: finalUrl, ref: finalUrl, filename: name, contentType: type };
  },
});
