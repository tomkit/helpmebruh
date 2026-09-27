// iMessage channel. The Mac bridge (bridge/bridge.mjs) POSTs each triggered
// message here; each iMessage chat (DM or group) maps to one durable eve
// session. The response is an NDJSON stream so the bridge can show progress:
//   {"type":"activity","activity":"Search the web for ..."}   as tools start
//   {"type":"heartbeat"}                                      every 15s
//   {"type":"done","reply":"...","attachments":[...]}         on success
//   {"type":"error","message":"..."}                          on failure
// Every stream ends with exactly one "done" or "error" line.
import { defineChannel, GET, POST, type RouteHandlerArgs } from "eve/channels";

import { type ChatImageRef, recentImages, rememberImages, savedResult, saveResult } from "../lib/chat-state";
import { fileRef, getOutboxFile, putOutboxFile } from "../lib/outbox";

type Incoming = {
  messageId?: number; // the bridge's id for the triggering message (for dedupe)
  text: string;
  sender: string; // 'me' or the sender's phone/email
  chat: { id: string; name: string | null; isGroup: boolean };
  history: { from: string; text: string }[]; // from: 'me' | 'assistant' | phone/email
  images?: Upload[]; // photos sent with (or just before) the message
  // Set when the message is an inline reply: the thread it replies to.
  thread?: { messages: { from: string; text: string }[]; images: Upload[] };
};

type Upload = { filename: string; contentType: string; data: string }; // base64

// Tools whose results are files to send into the chat.
const FILE_TOOLS = new Set(["send_attachment", "generate_image"]);

// `url` is absolute for web files, or relative to this agent for sandbox files.
type Attachment = { url: string; filename: string; contentType: string };

type StreamEvent = {
  type: string;
  data?: Record<string, unknown>;
};

const HEARTBEAT_MS = 15_000;

// Session address for a chat. Bump the version to start every chat on a fresh
// session at once (e.g. after sessions from `eve dev` that the production
// server can't resume).
const address = (chatId: string) => `v2:${chatId}`;

const label = (from: string) => (from === "me" ? "Owner" : from === "assistant" ? "You" : from);
const clock = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" });

function formatPrompt(body: Incoming, sentNow: string[], threadRefs: string[], earlier: ChatImageRef[]) {
  const where = body.chat.isGroup ? `group chat "${body.chat.name ?? "unnamed"}"` : "direct message";
  const recent = body.history.map((m) => `${label(m.from)}: ${m.text}`).join("\n");
  const images = earlier
    .map((img, i) => `${i + 1}. ${img.ref} (${img.filename}, from ${img.from}, ${clock(img.at)}): ${img.note}`)
    .join("\n");
  return (
    `[iMessage ${where}]\n` +
    (recent ? `Recent messages:\n${recent}\n\n` : "") +
    (images ? `Recent images in this chat, newest first (refs work with look_at_image / generate_image):\n${images}\n\n` : "") +
    (body.thread
      ? `They're replying to this thread (the first message is the one they replied to):\n` +
        `${body.thread.messages.map((m) => `${label(m.from)}: ${m.text}`).join("\n")}\n` +
        (threadRefs.length ? `Images in that thread: ${threadRefs.join(", ")}\n` : "") +
        "\n"
      : "") +
    (sentNow.length ? `Images sent with this message: ${sentNow.join(", ")}\n\n` : "") +
    `${label(body.sender)} asks you: ${body.text}`
  );
}

type TurnResult = { reply: string; attachments: Attachment[] };
type ChannelOps = Pick<RouteHandlerArgs, "from" | "resolveSession" | "attachSession">;

// Turns in progress, by message key, so a retry of the same message joins the
// running turn instead of starting another.
const inflight = new Map<string, Promise<TurnResult>>();

// Fails closed: no configured secret means nothing is authorized.
function authorized(request: Request) {
  const secret = process.env.AGENT_SECRET;
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

const unauthorized = () => new Response("Unauthorized", { status: 401 });

export default defineChannel({
  // A follow-up in the same chat waits for the current turn instead of interrupting it.
  turnPolicy: "queue",

  routes: [
    GET("/imessage/files/:id", async (request, { params }) => {
      if (!authorized(request)) return unauthorized();
      const file = await getOutboxFile(params.id);
      return file ? new Response(file) : new Response("Not found", { status: 404 });
    }),

    // Starts the chat over with a fresh session (e.g. after a stuck turn).
    POST("/imessage/reset", async (request, { from }) => {
      if (!authorized(request)) return unauthorized();
      const { chatId } = (await request.json()) as { chatId: string };
      return Response.json(await from(address(chatId)).reset({ reason: "Reset from iMessage" }));
    }),

    POST("/imessage", async (request, ops) => {
      if (!authorized(request)) return unauthorized();
      const body = (await request.json()) as Incoming;
      const encoder = new TextEncoder();
      const key = body.messageId == null ? null : `${body.chat.id}:${body.messageId}`;

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          // The bridge may disconnect (e.g. restart); the turn keeps running and
          // its result is saved, so ignore writes to a closed stream.
          const write = (line: object) => {
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
            } catch {}
          };
          const heartbeat = setInterval(() => write({ type: "heartbeat" }), HEARTBEAT_MS);
          try {
            const saved = key && savedResult(body.chat.id, String(body.messageId));
            let result: TurnResult;
            if (saved) {
              result = saved as TurnResult;
            } else if (key && inflight.has(key)) {
              result = await inflight.get(key)!;
            } else {
              const turn = runTurn(body, ops, (activity) => write({ type: "activity", activity }));
              if (key) inflight.set(key, turn);
              try {
                result = await turn;
              } finally {
                if (key) inflight.delete(key);
              }
            }
            write({ type: "done", ...result });
          } catch (err) {
            write({ type: "error", message: err instanceof Error ? err.message : String(err) });
          } finally {
            clearInterval(heartbeat);
            try {
              controller.close();
            } catch {}
          }
        },
      });

      return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
    }),
  ],
});

// Drops short leading status lines ("Finalizing now.") that the model sometimes
// puts before the answer in its final message. Only paragraphs that look like
// narration are removed, and never the last one.
const NARRATION = /\b(finaliz\w*|let me|i'll now|now i'll|one sec|on it|still (blocking|working|trying)|wrapping up|putting (it|this) together)\b/i;
function stripStatusLines(reply: string) {
  const paragraphs = reply.split(/\n\s*\n/);
  while (paragraphs.length > 1 && paragraphs[0].length <= 200 && NARRATION.test(paragraphs[0])) paragraphs.shift();
  return paragraphs.join("\n\n");
}

// Sends one message into the chat's session and waits for its turn to finish.
async function runTurn(
  body: Incoming,
  { from, resolveSession, attachSession }: ChannelOps,
  onActivity: (activity: string) => void,
): Promise<TurnResult> {
  // Only read events written after this message was accepted.
  const existing = await resolveSession(address(body.chat.id));
  const startIndex = existing ? await existing.getStreamTailIndex() : 0;

  const now = new Date().toISOString();
  const store = (uploads: Upload[] | undefined, note: string) =>
    Promise.all(
      (uploads ?? []).map(async (img) => ({
        ref: fileRef(await putOutboxFile(Buffer.from(img.data, "base64"), img.filename)),
        filename: img.filename,
        at: now,
        from: label(body.sender),
        note,
      })),
    );
  const sentNow = await store(body.images, `sent with "${body.text.slice(0, 100)}"`);
  const threadImages = await store(body.thread?.images, `in the thread replied to with "${body.text.slice(0, 100)}"`);
  const prompt = formatPrompt(
    body,
    sentNow.map((i) => i.ref),
    threadImages.map((i) => i.ref),
    recentImages(body.chat.id),
  );
  rememberImages(body.chat.id, [...threadImages, ...sentNow]);

  // The bridge vouches for the sender; tools use `role` for owner-only actions.
  const auth = {
    authenticator: "imessage-bridge",
    principalType: "user",
    principalId: body.sender === "me" ? "owner" : body.sender,
    attributes: { role: body.sender === "me" ? "owner" : "guest" },
  };
  const session = await from(address(body.chat.id)).send(prompt, { auth });
  const events = (await attachSession(session.id).getEventStream({ startIndex })).getReader();

  // With turnPolicy "queue" an earlier turn may still be streaming, so only
  // collect events after this message is received.
  const needle = JSON.stringify(prompt).slice(1, -1);
  let ours = false;
  let finished = false;
  let reply = "";
  const attachments: Attachment[] = [];
  const sentRefs: string[] = [];
  try {
    while (!finished) {
      const { done, value } = await events.read();
      if (done) break;
      const event = value as StreamEvent;
      if (!ours) {
        ours = event.type === "message.received" && JSON.stringify(event.data).includes(needle);
        continue;
      }

      if (event.type === "actions.requested") {
        const presentation = (event.data?.presentation ?? {}) as Record<string, { label?: string }>;
        const labels = Object.values(presentation).map((p) => p.label).filter(Boolean);
        if (labels.length) onActivity(labels.join(", "));
      } else if (event.type === "action.result") {
        const result = event.data?.result as
          | { kind?: string; toolName?: string; isError?: boolean; output?: unknown }
          | undefined;
        if (result?.kind === "tool-result" && FILE_TOOLS.has(result.toolName ?? "") && !result.isError) {
          const out = result.output as Partial<Attachment> & { queued?: boolean; fileId?: string };
          const url = out?.fileId ? `/imessage/files/${out.fileId}` : out?.url;
          if (out?.queued && url && !attachments.some((a) => a.url === url)) {
            attachments.push({ url, filename: out.filename ?? "attachment", contentType: out.contentType ?? "" });
            sentRefs.push(out.fileId ? fileRef(out.fileId) : url);
          }
        }
      } else if (event.type === "message.completed" && typeof event.data?.message === "string") {
        reply = event.data.message; // last completed block is the final answer
      } else if (event.type === "authorization.required") {
        const auth = event.data?.authorization as { url?: string } | undefined;
        if (auth?.url) reply = `I need you to sign in first: ${auth.url}`;
      } else if (event.type === "turn.failed" || event.type === "session.failed") {
        throw new Error(String(event.data?.message ?? event.type));
      } else if (event.type === "turn.cancelled") {
        throw new Error("the request was cancelled");
      } else if (event.type === "turn.completed") {
        finished = true;
      }
    }
  } finally {
    await events.cancel().catch(() => {});
  }

  if (!finished) throw new Error("the agent stopped before finishing");
  reply = stripStatusLines(reply.trim());
  if (!reply && !attachments.length) throw new Error("the agent finished without a reply");

  const at = new Date().toISOString();
  rememberImages(
    body.chat.id,
    attachments.map((a, i) => ({ ref: sentRefs[i], filename: a.filename, at, from: "You", note: reply.slice(0, 120) })),
  );
  const result = { reply, attachments };
  if (body.messageId != null) saveResult(body.chat.id, String(body.messageId), { ...result, at });
  return result;
}
