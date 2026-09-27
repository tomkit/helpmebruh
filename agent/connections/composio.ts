// Composio Tool Router: one hosted MCP endpoint that discovers tools across
// 1000+ apps and handles just-in-time OAuth (it returns a sign-in link when an
// app isn't connected yet). Credentials live in Composio's vault, keyed by the
// Composio user id below, and never reach the model. Owner-only: calls from
// anyone else (e.g. others in a group chat) are denied automatically.
import { Composio } from "@composio/core";
import { defineDynamic, defineMcpClientConnection } from "eve/connections";

// Single-owner assistant: every chat acts on the owner's connected accounts.
const COMPOSIO_USER_ID = process.env.COMPOSIO_USER_ID ?? "owner";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const composio = new Composio({ allowTracking: false });
      const session = await composio.create(COMPOSIO_USER_ID, { mcp: true });

      return defineMcpClientConnection({
        url: session.mcp.url,
        headers: session.mcp.headers,
        description:
          "The owner's apps and accounts via Composio: Gmail, Google Calendar, Drive, Slack, GitHub, Notion and 1000+ more. Search for tools, execute them, and manage app connections (returns sign-in links for apps that aren't connected yet).",
        instanceKey: COMPOSIO_USER_ID,
        approval: ({ session }) =>
          session.auth.current?.attributes.role === "owner"
            ? "not-applicable"
            : {
                type: "denied",
                reason: "Only the owner can use their connected accounts (email, calendar, etc.). Tell the person you can't do that for them.",
              },
      });
    },
  },
});
