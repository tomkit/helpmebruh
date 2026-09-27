// iMessage <-> agent bridge. Runs on the Mac that's signed into Messages.
// Watches ~/Library/Messages/chat.db for messages that start with the trigger,
// POSTs them (plus recent chat history) to AGENT_URL, and sends the reply
// back into the same chat (DM or group) via AppleScript.
//
// Fails closed: every triggered message ends in a reply or an explicit failure
// message, including messages interrupted by a restart (tracked in .state.json).
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const DB_PATH = join(homedir(), 'Library/Messages/chat.db');
const STATE_PATH = new URL('./.state.json', import.meta.url);
const AGENT_URL = process.env.AGENT_URL ?? 'http://127.0.0.1:2000/imessage';
const AGENT_SECRET = process.env.AGENT_SECRET ?? '';
// Options from the admin page (http://localhost:2000/admin), read live from
// .state/settings.json; env vars are the fallback when a setting isn't saved.
const SETTINGS_PATH = new URL('../.state/settings.json', import.meta.url);
const SETTINGS_DEFAULTS = {
  trigger: process.env.TRIGGER || '/bruh',
  replyPrefix: process.env.REPLY_PREFIX || '🤖',
  ack: true, // send the reply prefix right away as an acknowledgement
  updateAfterMinutes: 2, // send it again if the agent is still working (0 = off)
  allowedSenders: (process.env.ALLOWED_SENDERS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  groupAccess: 'allowlist', // who else can trigger it in groups: owner | allowlist | everyone
  historyMessages: 15,
  replyThreadContext: true,
  timeoutMinutes: Number(process.env.AGENT_TIMEOUT_MS ?? 30 * 60_000) / 60_000,
};
let settingsCache;
function settings() {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(SETTINGS_PATH).mtimeMs;
  } catch {}
  if (settingsCache?.mtimeMs !== mtimeMs) {
    let saved = {};
    try {
      saved = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    } catch {}
    const value = { ...SETTINGS_DEFAULTS, ...saved };
    const escaped = value.trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    value.triggerRe = new RegExp(`^${escaped}(?:\\s+|$)`, 'i');
    value.allowed = new Set(value.allowedSenders);
    settingsCache = { mtimeMs, value };
  }
  return settingsCache.value;
}
// A request fails if it takes longer than the configured timeout, or if the
// agent goes silent (it sends a heartbeat every 15s) for longer than IDLE_TIMEOUT_MS.
const IDLE_TIMEOUT_MS = 60_000;
// A message interrupted by a restart is retried once, then reported as failed.
const MAX_ATTEMPTS = 2;
const POLL_MS = 500;
// Messages is sandboxed and only reliably sends files staged inside its own
// Attachments folder (files sent from elsewhere show "Not Delivered").
const OUTBOX = join(homedir(), 'Library', 'Messages', 'Attachments', 'helpmebruh-outbox');
// How long to wait for Messages to confirm (or fail) a file send.
const FILE_SEND_CHECK_MS = 30_000;
const OUTBOX_TTL_MS = 24 * 60 * 60 * 1000;
// Photos sent with (or just before) a triggered message are passed to the agent.
const IMAGE_LOOKBACK_SEC = 120;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

let db;
try {
  db = new DatabaseSync(DB_PATH, { readOnly: true });
  db.prepare('SELECT 1 FROM message LIMIT 1').get();
} catch (err) {
  console.error(`Can't read ${DB_PATH}: ${err.message}`);
  console.error(
    'Grant Full Disk Access to the app running this (Terminal/iTerm, or the node binary):\n' +
      '  System Settings → Privacy & Security → Full Disk Access',
  );
  process.exit(1);
}

const newMessages = db.prepare(`
  SELECT m.ROWID AS id, m.text, m.attributedBody, m.is_from_me AS fromMe, m.handle_id AS handleId,
         m.thread_originator_guid AS threadRoot, h.id AS handle, c.ROWID AS chatRowId, c.guid AS chatGuid,
         c.display_name AS chatName, c.style AS chatStyle
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c ON c.ROWID = cmj.chat_id
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  WHERE m.ROWID > ? AND m.associated_message_type = 0 AND m.item_type = 0
  ORDER BY m.ROWID`);

const chatHistory = db.prepare(`
  SELECT m.text, m.attributedBody, m.is_from_me AS fromMe, h.id AS handle
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  WHERE cmj.chat_id = ? AND m.ROWID < ? AND m.associated_message_type = 0 AND m.item_type = 0
  ORDER BY m.ROWID DESC LIMIT ?`);

// Newer macOS often leaves `text` NULL and stores it in `attributedBody`
// (an NSAttributedString typedstream). Pull the NSString payload out of it.
function messageText(row) {
  if (row.text) return row.text;
  const body = row.attributedBody && Buffer.from(row.attributedBody);
  if (!body) return '';
  const i = body.indexOf('NSString');
  if (i < 0) return '';
  let p = i + 'NSString'.length + 5;
  let len = body[p];
  if (len === 0x81) { len = body.readUInt16LE(p + 1); p += 3; }
  else if (len === 0x82) { len = body.readUInt32LE(p + 1); p += 5; }
  else p += 1;
  return body.subarray(p, p + len).toString('utf8');
}

const messageById = db.prepare(`
  SELECT m.ROWID AS id, m.text, m.attributedBody, m.is_from_me AS fromMe, m.handle_id AS handleId,
         m.thread_originator_guid AS threadRoot, h.id AS handle, c.ROWID AS chatRowId, c.guid AS chatGuid,
         c.display_name AS chatName, c.style AS chatStyle
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c ON c.ROWID = cmj.chat_id
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  WHERE m.ROWID = ?`);

// Image attachments on the triggering message, or on the sender's messages in
// the same chat shortly before it (a photo and its caption are separate rows).
const recentImages = db.prepare(`
  SELECT a.filename AS path, a.mime_type AS mimeType, a.transfer_name AS name
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN message_attachment_join maj ON maj.message_id = m.ROWID
  JOIN attachment a ON a.ROWID = maj.attachment_id
  WHERE cmj.chat_id = ? AND m.ROWID <= ? AND m.is_from_me = ? AND IFNULL(m.handle_id, 0) = IFNULL(?, 0)
    AND m.date >= (SELECT date FROM message WHERE ROWID = ?) - ? * 1000000000
    AND a.mime_type LIKE 'image/%'
  ORDER BY m.ROWID DESC LIMIT ?`);

// When a triggering message is an inline reply: the message it replies to (the
// thread root) and the other replies in that thread, newest first.
const MAX_THREAD_MESSAGES = 30;
const threadMessages = db.prepare(`
  SELECT m.text, m.attributedBody, m.is_from_me AS fromMe, h.id AS handle
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  WHERE cmj.chat_id = ? AND m.ROWID < ? AND (m.guid = ? OR m.thread_originator_guid = ?)
    AND m.associated_message_type = 0 AND m.item_type = 0
  ORDER BY m.ROWID DESC LIMIT ?`);
// The message a reply points at (thread root), and the message right above the
// triggering one in the chat, to tell whether the reply needs a quote.
const messageByGuid = db.prepare(`
  SELECT m.text, m.attributedBody, m.is_from_me AS fromMe, h.id AS handle,
         EXISTS (SELECT 1 FROM message_attachment_join maj WHERE maj.message_id = m.ROWID) AS hasAttachment
  FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id
  WHERE m.guid = ?`);
const previousMessageGuid = db.prepare(`
  SELECT m.guid FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  WHERE cmj.chat_id = ? AND m.ROWID < ? AND m.associated_message_type = 0
  ORDER BY m.ROWID DESC LIMIT 1`);
const QUOTE_CHARS = 40;

const threadImages = db.prepare(`
  SELECT a.filename AS path, a.mime_type AS mimeType, a.transfer_name AS name
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN message_attachment_join maj ON maj.message_id = m.ROWID
  JOIN attachment a ON a.ROWID = maj.attachment_id
  WHERE cmj.chat_id = ? AND m.ROWID < ? AND (m.guid = ? OR m.thread_originator_guid = ?)
    AND a.mime_type LIKE 'image/%'
  ORDER BY m.ROWID DESC LIMIT ?`);

// The newest outgoing message in a chat carrying an attachment with this name.
const sentAttachment = db.prepare(`
  SELECT m.ROWID AS id, m.error, m.is_sent AS isSent, m.is_delivered AS isDelivered
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c ON c.ROWID = cmj.chat_id
  JOIN message_attachment_join maj ON maj.message_id = m.ROWID
  JOIN attachment a ON a.ROWID = maj.attachment_id
  WHERE c.guid = ? AND m.is_from_me = 1 AND a.transfer_name = ? AND m.ROWID > ?
  ORDER BY m.ROWID DESC LIMIT 1`);

// { lastId, pending: { [messageId]: attempts } }. Pending is written before a
// message is handled and cleared after its reply or failure notice is sent.
function loadState() {
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return { lastId: state.lastId, pending: state.pending ?? {} };
  } catch {
    // First run: start from now, don't replay old messages.
    return { lastId: db.prepare('SELECT MAX(ROWID) AS id FROM message').get().id ?? 0, pending: {} };
  }
}

function saveState() {
  writeFileSync(STATE_PATH, JSON.stringify(state));
}

const log = (...args) => console.log(new Date().toISOString(), ...args);
const logError = (...args) => console.error(new Date().toISOString(), ...args);

function osascript(script, args) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script, ...args], (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout.trim()),
    );
  });
}

const SEND_SCRIPT = `on run argv
  tell application "Messages" to send (item 1 of argv) to chat id (item 2 of argv)
end run`;

const SEND_FILE_SCRIPT = `on run argv
  tell application "Messages" to send (POSIX file (item 1 of argv)) to chat id (item 2 of argv)
end run`;

// chat.db guids and AppleScript chat ids use different service prefixes across
// macOS versions (any; / iMessage; / SMS;), so try each until one works.
async function sendToChat(chatGuid, text, script = SEND_SCRIPT) {
  const rest = chatGuid.replace(/^[^;]+;/, '');
  const candidates = [...new Set([chatGuid, `iMessage;${rest}`, `any;${rest}`, `SMS;${rest}`])];
  let lastErr;
  for (const id of candidates) {
    try {
      return await osascript(script, [text, id]);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Downloads an attachment into OUTBOX and returns its path. Old files are
// pruned later rather than right away, since Messages uploads asynchronously.
async function download({ url, filename }) {
  mkdirSync(OUTBOX, { recursive: true });
  // Files the agent created are served by the agent itself (relative URL, needs the secret).
  const abs = new URL(url, AGENT_URL);
  const headers = { 'user-agent': 'Mozilla/5.0' };
  if (abs.origin === new URL(AGENT_URL).origin) headers.authorization = `Bearer ${AGENT_SECRET}`;
  const res = await fetch(abs, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let safe = (filename || 'attachment').replace(/[^\w.\- ]+/g, '_').slice(-100);
  // Keep the real type visible in the name (Messages and the JPEG fix rely on it).
  const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }[
    res.headers.get('content-type')?.split(';')[0].trim()
  ];
  if (ext && !safe.toLowerCase().endsWith(ext) && !(ext === '.jpg' && /\.jpeg$/i.test(safe))) safe += ext;
  const path = join(OUTBOX, `${Date.now()}-${safe}`);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  return path;
}

function pruneOutbox() {
  try {
    for (const f of readdirSync(OUTBOX)) {
      const p = join(OUTBOX, f);
      if (Date.now() - statSync(p).mtimeMs > OUTBOX_TTL_MS) rmSync(p);
    }
  } catch {}
}

// POSTs the message and reads the agent's NDJSON stream until "done" or
// "error". Throws on any failure, including timeouts and a dropped connection.
async function askAgent(payload, onActivity) {
  const controller = new AbortController();
  const overall = setTimeout(() => controller.abort(new Error('timed out')), settings().timeoutMinutes * 60_000);
  let idle;
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new Error('the agent stopped responding')), IDLE_TIMEOUT_MS);
  };
  try {
    resetIdle();
    const res = await fetch(AGENT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${AGENT_SECRET}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`agent returned ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      resetIdle();
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.type === 'activity') onActivity(event.activity);
        else if (event.type === 'error') throw new Error(event.message);
        else if (event.type === 'done') return event;
      }
    }
    throw new Error('the connection to the agent closed early');
  } catch (err) {
    throw controller.signal.aborted ? controller.signal.reason : err;
  } finally {
    clearTimeout(overall);
    clearTimeout(idle);
  }
}

// Photos sent with (or just before) the triggering message.
const collectImages = (msg) =>
  readImages(recentImages.all(msg.chatRowId, msg.id, msg.fromMe, msg.handleId, msg.id, IMAGE_LOOKBACK_SEC, MAX_IMAGES));

// The thread an inline reply points at: its messages (oldest first) and photos.
// Messages' AppleScript can't post inline replies, so a reply to a message that
// isn't right above the trigger starts with a short quote of it instead.
function replyQuote(msg) {
  if (!msg.threadRoot) return '';
  if (previousMessageGuid.get(msg.chatRowId, msg.id)?.guid === msg.threadRoot) return '';
  const root = messageByGuid.get(msg.threadRoot);
  if (!root) return '';
  const text = historyEntry(root).text.replace(/\[attachment\]/g, '').replace(/\s+/g, ' ').trim();
  const quote = text ? `"${text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS - 1)}…` : text}"` : '📷 photo';
  return `↪ ${root.hasAttachment && text ? `📷 ${quote}` : quote} — `;
}

async function collectThread(msg) {
  if (!msg.threadRoot || !settings().replyThreadContext) return undefined;
  const args = [msg.chatRowId, msg.id, msg.threadRoot, msg.threadRoot];
  const messages = threadMessages.all(...args, MAX_THREAD_MESSAGES).reverse().map(historyEntry);
  return { messages, images: await readImages(threadImages.all(...args, MAX_IMAGES)) };
}

// One chat message as the agent sees it.
function historyEntry(r) {
  const text = messageText(r);
  const { replyPrefix } = settings();
  const isBot = r.fromMe && text.startsWith(replyPrefix);
  // U+FFFC stands in for an attachment in the message text.
  const clean = (isBot ? text.slice(replyPrefix.length).trim() : text).replace(/\uFFFC/g, '[attachment]');
  return { from: isBot ? 'assistant' : r.fromMe ? 'me' : r.handle ?? 'unknown', text: clean };
}

// Reads image attachment rows (newest first) for the agent, converting
// HEIC/other formats to JPEG with macOS's built-in `sips` so every model can read them.
async function readImages(rows) {
  const images = [];
  for (const row of rows.reverse()) {
    const path = row.path?.replace(/^~(?=\/)/, homedir());
    if (!path || !existsSync(path)) continue; // not downloaded yet (e.g. iCloud)
    let file = path;
    let contentType = row.mimeType;
    let filename = row.name || basename(path);
    let scratch;
    try {
      if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(contentType)) {
        scratch = mkdtempSync(join(tmpdir(), 'bridge-img-'));
        file = join(scratch, 'image.jpg');
        await new Promise((ok, fail) =>
          execFile('sips', ['-s', 'format', 'jpeg', path, '--out', file], (err) => (err ? fail(err) : ok())),
        );
        contentType = 'image/jpeg';
        filename = filename.replace(/\.[^.]+$/, '') + '.jpg';
      }
      const data = readFileSync(file);
      if (data.length > MAX_IMAGE_BYTES) continue;
      images.push({ filename, contentType, data: data.toString('base64') });
    } catch (err) {
      logError(`Couldn't read attachment ${path}:`, err.message);
    } finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  }
  return images;
}

async function resetChat(chatGuid) {
  const res = await fetch(new URL('/imessage/reset', AGENT_URL), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${AGENT_SECRET}` },
    body: JSON.stringify({ chatId: chatGuid }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`reset returned ${res.status}`);
}

// macOS 26.2 Messages fails to send JPEG attachments ("Not Delivered", fixed in
// 26.3), so convert JPEGs to HEIC first. Returns the path to send.
async function sendablePath(path) {
  if (!/\.jpe?g$/i.test(path)) return path;
  const heic = path.replace(/\.jpe?g$/i, '.heic');
  await new Promise((ok, fail) =>
    execFile('sips', ['-s', 'format', 'heic', path, '--out', heic], (err) => (err ? fail(err) : ok())),
  );
  return heic;
}

// Sends a file and waits for Messages to confirm it went out. AppleScript
// reports success even when Messages later marks the file "Not Delivered".
async function sendFile(msg, path) {
  const since = db.prepare('SELECT MAX(ROWID) AS id FROM message').get().id ?? 0;
  path = await sendablePath(path);
  await sendToChat(msg.chatGuid, path, SEND_FILE_SCRIPT);
  const name = basename(path);
  const deadline = Date.now() + FILE_SEND_CHECK_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const row = sentAttachment.get(msg.chatGuid, name, since);
    if (row?.error) throw new Error(`Messages couldn't deliver it (error ${row.error})`);
    if (row?.isSent || row?.isDelivered) return;
  }
  throw new Error("Messages didn't confirm the file was sent");
}

const say = (msg, text) => {
  const { replyPrefix } = settings();
  return sendToChat(msg.chatGuid, text ? `${replyPrefix} ${text}` : replyPrefix);
};

// Always ends with a reply or a failure notice in the chat.
async function handle(msg, prompt) {
  log(`→ [${msg.chatName || msg.chatGuid}] ${msg.fromMe ? 'me' : msg.handle}: ${prompt}`);
  try {
    if (/^(reset|new)$/i.test(prompt)) {
      await resetChat(msg.chatGuid);
      await say(msg, 'Fresh start: I cleared my memory of this chat.');
      log('← reset');
      return;
    }
    await converse(msg, prompt);
  } catch (err) {
    logError(`Failed [${msg.chatGuid}]:`, err.message);
    try {
      await say(msg, `⚠️ Sorry, that failed (${err.message}). Try again, or send "${settings().trigger} reset" if I seem stuck.`);
    } catch (sendErr) {
      logError(`Couldn't send failure notice to ${msg.chatGuid}:`, sendErr.message);
    }
  }
}

async function converse(msg, prompt) {
  const isGroup = msg.chatStyle === 43;
  const history = chatHistory
    .all(msg.chatRowId, msg.id, settings().historyMessages)
    .reverse()
    .map(historyEntry)
    // Drop the bridge's own progress messages; they're noise for the agent.
    .filter((r) => r.text && !(r.from === 'assistant' && r.text.startsWith('⏳')));

  // Acknowledge right away with just the reply prefix (Messages' AppleScript
  // can't add tapback reactions).
  const { ack, updateAfterMinutes } = settings();
  if (ack) say(msg, '').catch((err) => logError(`Ack failed for ${msg.chatGuid}:`, err.message));
  const nudge =
    updateAfterMinutes > 0 &&
    setTimeout(() => {
      say(msg, '').catch((err) => logError(`Nudge failed for ${msg.chatGuid}:`, err.message));
    }, updateAfterMinutes * 60_000);

  const result = await askAgent(
    {
      messageId: msg.id,
      text: prompt,
      sender: msg.fromMe ? 'me' : msg.handle,
      chat: { id: msg.chatGuid, name: msg.chatName || null, isGroup },
      history,
      images: await collectImages(msg),
      thread: await collectThread(msg),
    },
    () => {},
  ).finally(() => clearTimeout(nudge));

  let reply = result.reply ?? '';
  for (const attachment of result.attachments ?? []) {
    try {
      const path = await download(attachment);
      await sendFile(msg, path);
      log(`← [file] ${attachment.filename}`);
    } catch (err) {
      logError(`Attachment failed (${attachment.url}):`, err.message);
      // Web files can fall back to a link; files the agent made only exist on this Mac.
      const link = /^https?:/.test(attachment.url) ? `: ${attachment.url}` : '';
      reply = `${reply}\n\n⚠️ Couldn't send ${attachment.filename} (${err.message})${link}`.trim();
    }
  }
  if (reply) {
    await say(msg, replyQuote(msg) + reply);
    log(`← ${reply.slice(0, 120)}`);
  }
}

const state = loadState();

function track(msg, prompt) {
  state.pending[msg.id] = (state.pending[msg.id] ?? 0) + 1;
  saveState();
  handle(msg, prompt).finally(() => {
    delete state.pending[msg.id];
    saveState();
  });
}

// You can always trigger it. Others: in DMs only if on the allowed list; in
// groups per the admin page's group access setting.
function canTrigger(msg) {
  if (msg.fromMe) return true;
  const { allowed, groupAccess } = settings();
  if (msg.chatStyle === 43 && groupAccess !== 'allowlist') return groupAccess === 'everyone';
  return allowed.has(msg.handle);
}

const promptOf = (msg) => {
  const match = messageText(msg).trim().match(settings().triggerRe);
  return match ? messageText(msg).trim().slice(match[0].length).trim() || 'hi' : null;
};

// Messages interrupted by a restart: retry once, then report the failure.
function recoverPending() {
  for (const [id, attempts] of Object.entries(state.pending)) {
    const msg = messageById.get(Number(id));
    const prompt = msg && promptOf(msg);
    if (!prompt) {
      delete state.pending[id];
    } else if (attempts >= MAX_ATTEMPTS) {
      delete state.pending[id];
      logError(`Giving up on interrupted message #${id}: ${prompt}`);
      say(msg, `⚠️ Sorry, I got interrupted and couldn't finish "${prompt.slice(0, 60)}". Please send it again.`).catch(
        (err) => logError(`Couldn't send failure notice to ${msg.chatGuid}:`, err.message),
      );
    } else {
      log(`Retrying interrupted message #${id}`);
      track(msg, prompt);
    }
  }
  saveState();
}

log(`Bridge running. Trigger: "${settings().trigger}" → ${AGENT_URL} (from message #${state.lastId})`);

function poll() {
  let rows;
  try {
    rows = newMessages.all(state.lastId);
  } catch (err) {
    logError('DB read failed:', err.message); // e.g. locked mid-write; retry next tick
    return;
  }
  for (const msg of rows) {
    state.lastId = Math.max(state.lastId, msg.id);
    const prompt = promptOf(msg);
    if (!prompt) continue;
    if (!canTrigger(msg)) continue;
    track(msg, prompt);
  }
  if (rows.length) saveState();
}

setInterval(poll, POLL_MS);
setInterval(pruneOutbox, 60 * 60 * 1000);
recoverPending();
poll();
