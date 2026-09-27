import { defineAgent, defineDynamic } from "eve";
import { anthropic } from "eve/models/anthropic";
import { chatgpt } from "eve/models/openai";

import { getSettings } from "./lib/settings";

export default defineAgent({
  // Chosen in the admin page; applies from the next message.
  model: defineDynamic({
    events: {
      "turn.started": () => {
        const { modelProvider, model } = getSettings();
        if (modelProvider === "chatgpt") return chatgpt(model);
        if (modelProvider === "anthropic") return anthropic(model);
        return model;
      },
    },
  }),
});
