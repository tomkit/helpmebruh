// Generates or edits an image with Gemini (Nano Banana 2) or GPT Image 2.5
// through AI Gateway. The result is stored in the outbox and sent into the
// iMessage chat automatically (the channel picks up this tool's results).
import { generateImage, generateText } from "ai";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { fileRef, loadFile, putOutboxFile } from "../lib/outbox";
import { getSettings } from "../lib/settings";

const MODELS = {
  gemini: "google/gemini-3.1-flash-image",
  "gpt-generate": "openai/gpt-image-2.5-flare",
  "gpt-edit": "openai/gpt-image-2.5-sunburst", // optimized for precise edits
} as const;

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export default defineTool({
  description:
    "Generate a new image, or edit/combine existing images, and send it into the iMessage chat. " +
    "Models: 'gemini' (Nano Banana 2) or 'gpt' (GPT Image 2.5); omit to use the owner's configured default unless one is asked for. " +
    "Pass input images as refs: 'file:<id>' (images people sent or earlier generated images), URLs, or sandbox paths. " +
    "The image is sent automatically; don't also call send_attachment for it.",
  inputSchema: z.object({
    prompt: z.string().min(1).describe("What to generate, or how to edit the input images."),
    model: z.enum(["gemini", "gpt"]).optional(),
    images: z.array(z.string()).max(4).optional().describe("Input image refs to edit or combine."),
    aspectRatio: z.enum(["1:1", "3:2", "2:3", "16:9", "9:16"]).optional(),
  }),
  label: {
    start: ({ model = getSettings().imageModel, images }) =>
      `${images?.length ? "Edit" : "Generate"} an image with ${model === "gpt" ? "GPT Image" : "Gemini"}`,
  },
  async execute({ prompt, model = getSettings().imageModel, images = [], aspectRatio }, ctx) {
    const inputs = await Promise.all(
      images.map((ref) =>
        loadFile(ref, async (path) => (await ctx.getSandbox()).readBinaryFile({ path })),
      ),
    );

    let bytes: Uint8Array;
    let mediaType: string;
    if (model === "gpt") {
      const size = { "1:1": "1024x1024", "3:2": "1536x1024", "16:9": "1536x1024", "2:3": "1024x1536", "9:16": "1024x1536" }[
        aspectRatio ?? "1:1"
      ] as `${number}x${number}`;
      const { image } = await generateImage({
        model: inputs.length ? MODELS["gpt-edit"] : MODELS["gpt-generate"],
        prompt: inputs.length ? { text: prompt, images: inputs.map((i) => i.bytes) } : prompt,
        size,
        abortSignal: ctx.abortSignal,
      });
      bytes = image.uint8Array;
      mediaType = image.mediaType;
    } else {
      const result = await generateText({
        model: MODELS.gemini,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: aspectRatio ? `${prompt}\n\nAspect ratio: ${aspectRatio}.` : prompt },
              ...inputs.map((i) => ({ type: "file" as const, data: i.bytes, mediaType: i.mediaType })),
            ],
          },
        ],
        abortSignal: ctx.abortSignal,
      });
      const file = result.files.find((f) => f.mediaType.startsWith("image/"));
      if (!file) throw new Error(`Gemini didn't return an image${result.text ? `: ${result.text.slice(0, 200)}` : "."}`);
      bytes = file.uint8Array;
      mediaType = file.mediaType;
    }

    const filename = `image-${Date.now()}.${EXT[mediaType] ?? "png"}`;
    const id = await putOutboxFile(bytes, filename);
    return { queued: true, fileId: id, ref: fileRef(id), filename, contentType: mediaType };
  },
});
