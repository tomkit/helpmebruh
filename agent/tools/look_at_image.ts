// Lets the (text-only) main model see images: a vision model answers a
// question about one or more images.
import { generateText } from "ai";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { loadFile } from "../lib/outbox";
import { getSettings } from "../lib/settings";

export default defineTool({
  description:
    "Look at images and answer a question about them (describe, read text, identify, compare). " +
    "You can't see images yourself, so use this whenever someone sends a photo or you need to check an image. " +
    "Pass image refs: 'file:<id>', URLs, or sandbox paths.",
  inputSchema: z.object({
    images: z.array(z.string()).min(1).max(4),
    question: z.string().default("Describe this image in detail."),
  }),
  label: { start: ({ images }) => `Look at ${images.length === 1 ? "an image" : `${images.length} images`}` },
  async execute({ images, question }, ctx) {
    const inputs = await Promise.all(
      images.map((ref) => loadFile(ref, async (path) => (await ctx.getSandbox()).readBinaryFile({ path }))),
    );
    const { text } = await generateText({
      model: getSettings().visionModel,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: question },
            ...inputs.map((i) => ({ type: "file" as const, data: i.bytes, mediaType: i.mediaType })),
          ],
        },
      ],
      abortSignal: ctx.abortSignal,
    });
    return text;
  },
});
