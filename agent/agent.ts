import { defineAgent, defineDynamic } from "eve";
import { anthropic } from "eve/models/anthropic";
import { chatgpt } from "eve/models/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import { getSettings } from "./lib/settings";

export default defineAgent({
  // Chosen in the admin page; applies from the next message.
  model: defineDynamic({
    events: {
      "step.started": () => {
        const { modelProvider, model } = getSettings();
        if (modelProvider === "chatgpt") return { model: chatgpt(model), modelContextWindowTokens: 128_000 };
        if (modelProvider === "anthropic") return { model: anthropic(model), modelContextWindowTokens: 128_000 };
        if (modelProvider === "openrouter") {
          const apiKey = process.env.OPENROUTER_API_KEY;
          if (!apiKey) throw new Error("OpenRouter needs OPENROUTER_API_KEY in .env.");
          return { model: createOpenRouter({ apiKey })(model), modelContextWindowTokens: 128_000 };
        }
        return model;
      },
    },
  }),
});
