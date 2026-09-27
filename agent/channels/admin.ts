// Local admin page for the owner: http://localhost:2000/admin
// The server only listens on 127.0.0.1. On top of that, requests must be
// addressed to localhost (blocks DNS rebinding), and the settings API requires
// a custom header plus a same-origin Origin, which other websites can't send
// without a CORS preflight this server never approves. Fails closed.
import { defineChannel, GET, POST, PUT } from "eve/channels";

import { codex, discoverCapabilities, validMarketplace, validPlugin } from "../lib/plugins";
import { getSettings, saveSettings } from "../lib/settings";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocal(request: Request) {
  const host = request.headers.get("host") ?? "";
  return LOCAL_HOSTS.has(host.replace(/:\d+$/, ""));
}

function isApiCall(request: Request) {
  if (!isLocal(request) || request.headers.get("x-admin-request") !== "1") return false;
  const origin = request.headers.get("origin");
  return !origin || LOCAL_HOSTS.has(new URL(origin).hostname);
}

const forbidden = () => new Response("Forbidden", { status: 403 });

export default defineChannel({
  routes: [
    GET("/admin", async (request) => {
      if (!isLocal(request)) return forbidden();
      return new Response(PAGE, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
          "cache-control": "no-store",
        },
      });
    }),

    GET("/admin/api/settings", async (request) => {
      if (!isApiCall(request)) return forbidden();
      return Response.json(getSettings());
    }),

    PUT("/admin/api/settings", async (request) => {
      if (!isApiCall(request)) return forbidden();
      try {
        return Response.json(saveSettings(await request.json()));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
      }
    }),

    GET("/admin/api/plugins", async (request) => {
      if (!isApiCall(request)) return forbidden();
      try {
        const [marketplaces, capabilities] = await Promise.all([
          codex(["plugin", "marketplace", "list", "--json"]), discoverCapabilities(),
        ]);
        return Response.json({ marketplaces: JSON.parse(marketplaces).marketplaces, capabilities });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }),

    POST("/admin/api/plugins", async (request) => {
      if (!isApiCall(request)) return forbidden();
      try {
        const body = await request.json() as { kind?: string; value?: string };
        let args: string[];
        if (body.kind === "marketplace" && validMarketplace(body.value)) {
          args = ["plugin", "marketplace", "add", body.value, "--json"];
        } else if (body.kind === "plugin" && validPlugin(body.value)) {
          args = ["plugin", "add", body.value, "--json"];
        } else {
          return Response.json({ error: "Enter a GitHub owner/repo or a plugin name@marketplace." }, { status: 400 });
        }
        return Response.json(JSON.parse(await codex(args)));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
      }
    }),
  ],
});

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bruh Admin</title>
<style>
  :root {
    --bg: #f6f6f4; --card: #ffffff; --text: #1d1d1f; --muted: #6e6e73; --line: #e3e3e0;
    --accent: #0a66ff; --accent-text: #ffffff; --ok: #1f8f4e; --err: #c2261d; --field: #fbfbfa;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #141415; --card: #1e1e20; --text: #f2f2f3; --muted: #a0a0a6; --line: #2e2e31;
      --accent: #4d8dff; --accent-text: #0b0b0c; --ok: #4cc27d; --err: #ff6b62; --field: #252528;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px 96px; }
  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 4px; }
  h1 { font-size: 26px; margin: 0; letter-spacing: -0.01em; }
  .lede { color: var(--muted); margin: 0 0 24px; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 4px 20px; margin-bottom: 16px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 18px 0 6px; }
  .row { display: grid; grid-template-columns: 1fr minmax(0, 280px); gap: 16px; align-items: center;
    padding: 14px 0; border-top: 1px solid var(--line); }
  h2 + .row { border-top: none; }
  .row label { font-weight: 600; display: block; }
  .row .help { color: var(--muted); font-size: 13px; margin-top: 2px; }
  input[type=text], input[type=number], select, textarea {
    width: 100%; font: inherit; color: var(--text); background: var(--field);
    border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
  textarea { min-height: 72px; resize: vertical; }
  input:focus, select:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .switch { justify-self: end; width: 44px; height: 26px; accent-color: var(--accent); }
  .plugin-form { display: flex; gap: 8px; padding: 12px 0; border-top: 1px solid var(--line); }
  .plugin-form input { flex: 1; min-width: 0; }
  .plugin-list { color: var(--muted); font-size: 13px; padding: 0 0 14px; overflow-wrap: anywhere; white-space: pre-line; }
  .bar { position: fixed; left: 0; right: 0; bottom: 0; background: var(--card); border-top: 1px solid var(--line); }
  .bar div { max-width: 760px; margin: 0 auto; padding: 12px 16px; display: flex; gap: 12px; align-items: center; justify-content: flex-end; }
  #status { margin-right: auto; color: var(--muted); font-size: 14px; }
  #status.ok { color: var(--ok); } #status.err { color: var(--err); }
  button { font: inherit; font-weight: 600; border-radius: 8px; padding: 9px 18px; cursor: pointer;
    border: 1px solid var(--line); background: var(--field); color: var(--text); }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
  button:disabled { opacity: 0.5; cursor: default; }
  @media (max-width: 560px) { .row { grid-template-columns: 1fr; gap: 8px; } .switch { justify-self: start; } }
</style>
</head>
<body>
<main>
  <header><h1>Bruh Admin</h1></header>
  <p class="lede">Settings for your iMessage agent. Changes apply to the next message; no restart needed.</p>
  <form id="form" autocomplete="off">
    <section>
      <h2>Messaging</h2>
      <div class="row"><div><label for="trigger">Trigger</label><div class="help">Messages starting with this go to the agent.</div></div>
        <input type="text" id="trigger" name="trigger" required maxlength="20"></div>
      <div class="row"><div><label for="replyPrefix">Reply prefix</label><div class="help">Starts every agent reply, so replies never re-trigger it.</div></div>
        <input type="text" id="replyPrefix" name="replyPrefix" required maxlength="8"></div>
      <div class="row"><div><label for="ack">Instant acknowledgement</label><div class="help">Send the reply prefix on its own as soon as a message arrives.</div></div>
        <input type="checkbox" class="switch" id="ack" name="ack"></div>
      <div class="row"><div><label for="updateAfterMinutes">Still-working nudge (minutes)</label><div class="help">If a request is still running after this long, send the reply prefix again. 0 turns it off.</div></div>
        <input type="number" id="updateAfterMinutes" name="updateAfterMinutes" min="0" max="30" step="0.5"></div>
      <div class="row"><div><label for="groupAccess">Who can trigger it in group chats</label><div class="help">Besides you. "Everyone" lets anyone in a group you're in use it (and spend on your models). Your accounts and coding agents stay owner-only either way.</div></div>
        <select id="groupAccess" name="groupAccess"><option value="owner">Only me</option><option value="allowlist">Me + allowed list</option><option value="everyone">Everyone in the group</option></select></div>
      <div class="row"><div><label for="allowedSenders">Allowed list</label><div class="help">Phone numbers or emails, one per line. They can use it in direct messages, and in groups when group access is "Me + allowed list".</div></div>
        <textarea id="allowedSenders" name="allowedSenders" placeholder="+15551234567"></textarea></div>
      <div class="row"><div><label for="historyMessages">Recent messages it sees</label><div class="help">How many earlier messages in the chat come with each request.</div></div>
        <input type="number" id="historyMessages" name="historyMessages" min="0" max="50"></div>
      <div class="row"><div><label for="replyThreadContext">Reply-thread context</label><div class="help">When you reply to a message, include that message and its thread (with photos).</div></div>
        <input type="checkbox" class="switch" id="replyThreadContext" name="replyThreadContext"></div>
      <div class="row"><div><label for="timeoutMinutes">Give up after (minutes)</label><div class="help">Longer requests end with a failure message in the chat.</div></div>
        <input type="number" id="timeoutMinutes" name="timeoutMinutes" min="1" max="120"></div>
    </section>

    <section>
      <h2>Models</h2>
      <div class="row"><div><label for="modelProvider">Main model connection</label><div class="help">One Eve tool loop; choose where its model calls go. ChatGPT uses the Codex login. API routers use their own keys.</div></div>
        <select id="modelProvider" name="modelProvider"><option value="chatgpt">ChatGPT subscription (Codex login)</option><option value="anthropic">Anthropic API</option><option value="openrouter">OpenRouter API</option><option value="gateway">Vercel AI Gateway</option></select></div>
      <div class="row"><div><label for="model">Agent model</label><div class="help">Model slug for the selected connection.</div></div>
        <input type="text" id="model" name="model" list="models" required></div>
      <div class="row"><div><label for="imageModel">Default image model</label><div class="help">Used unless a request asks for a specific one.</div></div>
        <select id="imageModel" name="imageModel"><option value="gemini">Gemini (Nano Banana 2)</option><option value="gpt">GPT Image 2.5</option></select></div>
      <div class="row"><div><label for="visionModel">Vision model</label><div class="help">Looks at photos for the agent.</div></div>
        <input type="text" id="visionModel" name="visionModel" list="vision" required></div>
    </section>

    <section>
      <h2>Tools</h2>
      <div class="row"><div><label for="browserProfile">Chrome profile</label><div class="help">Dedicated profile name used for signed-in browser tasks. Find it at chrome://version under Profile Path.</div></div>
        <input type="text" id="browserProfile" name="browserProfile" required placeholder="Default"></div>
      <div class="row"><div><label for="sandboxInternet">Sandbox internet access</label><div class="help">Lets code in the agent's Linux VM reach the internet. Applies to newly created sandboxes.</div></div>
        <input type="checkbox" class="switch" id="sandboxInternet" name="sandboxInternet"></div>
      <div class="row"><div><label for="codingEnabled">Coding agents</label><div class="help">Let the agent hand tasks to Claude Code or Codex on this Mac (owner only, sandboxed to one project folder).</div></div>
        <input type="checkbox" class="switch" id="codingEnabled" name="codingEnabled"></div>
      <div class="row"><div><label for="codingRoot">Projects folder</label><div class="help">Coding agents work in one project folder inside this. The assistant's own project is always off-limits.</div></div>
        <input type="text" id="codingRoot" name="codingRoot" required></div>
      <div class="row"><div><label for="codingDefault">Default coding agent</label><div class="help">Used unless a request asks for a specific one.</div></div>
        <select id="codingDefault" name="codingDefault"><option value="claude">Claude Code</option><option value="codex">Codex</option></select></div>
      <div class="row"><div><label for="capabilityDelegation">Delegate installed capabilities</label><div class="help">Run a fresh Codex or Claude Code session for plugins that need their original harness. Coding tasks have their own switch above.</div></div>
        <input type="checkbox" class="switch" id="capabilityDelegation" name="capabilityDelegation"></div>
      <div class="row"><div><label for="capabilityInherit">Inherit local capabilities in Bruh</label><div class="help">Load existing skill files into Eve and call supported local MCP servers directly. Reads current files each turn; no restart needed.</div></div>
        <input type="checkbox" class="switch" id="capabilityInherit" name="capabilityInherit"></div>
    </section>
  </form>
  <section>
    <h2>Capabilities &amp; plugins</h2>
    <p class="help">Bruh reads your installed Codex and Claude Code capabilities live. Inherited skills load in Eve; local MCP servers run directly. Remote OAuth servers and harness-only features use delegation when enabled. Install sources you trust.</p>
    <form class="plugin-form" id="marketplaceForm"><input type="text" id="marketplace" required placeholder="GitHub owner/repo" aria-label="GitHub marketplace repository"><button type="submit">Add marketplace</button></form>
    <form class="plugin-form" id="pluginForm"><input type="text" id="plugin" required placeholder="plugin@marketplace" aria-label="Plugin name"><button type="submit" class="primary">Install plugin</button></form>
    <button type="button" id="refreshPlugins">Refresh capabilities</button>
    <div class="plugin-list" id="pluginList">Loading capabilities…</div>
  </section>
  <datalist id="models"><option value="gpt-5.6-sol"><option value="gpt-6-sol"><option value="claude-sonnet-5"><option value="claude-opus-5.5"><option value="openrouter/auto"><option value="zai/glm-5.3"><option value="anthropic/claude-sonnet-5"></datalist>
  <datalist id="vision"><option value="google/gemini-3.8-flash"><option value="google/gemini-3.5-flash"><option value="zai/glm-5v-turbo"></datalist>
</main>
<div class="bar"><div><span id="status" role="status"></span>
  <button type="button" id="revert">Revert</button>
  <button type="submit" form="form" class="primary" id="save">Save</button></div></div>
<script>
const $ = (id) => document.getElementById(id);
const api = (method, body) => fetch("/admin/api/settings", {
  method, headers: { "x-admin-request": "1", "content-type": "application/json" },
  body: body && JSON.stringify(body),
}).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; });
const pluginApi = (method, body) => fetch("/admin/api/plugins", {
  method, headers: { "x-admin-request": "1", "content-type": "application/json" },
  body: body && JSON.stringify(body),
}).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; });

function status(text, kind) { const s = $("status"); s.textContent = text; s.className = kind || ""; }

function fill(s) {
  for (const k of ["trigger", "replyPrefix", "historyMessages", "timeoutMinutes", "modelProvider", "model", "imageModel", "visionModel", "groupAccess", "updateAfterMinutes", "browserProfile"]) $(k).value = s[k];
  for (const k of ["ack", "replyThreadContext", "sandboxInternet"]) $(k).checked = s[k];
  $("allowedSenders").value = s.allowedSenders.join("\\n");
  $("codingEnabled").checked = s.codingAgent.enabled;
  $("codingRoot").value = s.codingAgent.root;
  $("codingDefault").value = s.codingAgent.defaultAgent;
  $("capabilityDelegation").checked = s.capabilities.delegationEnabled;
  $("capabilityInherit").checked = s.capabilities.inheritEnabled;
}

function read() {
  return {
    trigger: $("trigger").value, replyPrefix: $("replyPrefix").value, ack: $("ack").checked,
    allowedSenders: $("allowedSenders").value.split(/[\\n,]/).map((s) => s.trim()).filter(Boolean),
    groupAccess: $("groupAccess").value, updateAfterMinutes: Number($("updateAfterMinutes").value),
    historyMessages: Number($("historyMessages").value), replyThreadContext: $("replyThreadContext").checked,
    timeoutMinutes: Number($("timeoutMinutes").value),
    modelProvider: $("modelProvider").value, model: $("model").value, imageModel: $("imageModel").value, visionModel: $("visionModel").value,
    sandboxInternet: $("sandboxInternet").checked, browserProfile: $("browserProfile").value,
    codingAgent: { enabled: $("codingEnabled").checked, root: $("codingRoot").value, defaultAgent: $("codingDefault").value },
    capabilities: { delegationEnabled: $("capabilityDelegation").checked, inheritEnabled: $("capabilityInherit").checked },
  };
}

async function load() {
  try { fill(await api("GET")); status(""); } catch (e) { status("Couldn't load settings: " + e.message, "err"); }
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("save").disabled = true; status("Saving…");
  try { fill(await api("PUT", read())); status("Saved. Applies to the next message.", "ok"); }
  catch (err) { status(err.message, "err"); }
  finally { $("save").disabled = false; }
});
$("revert").addEventListener("click", load);
const modelDefaults = { chatgpt: "gpt-5.6-sol", anthropic: "claude-sonnet-5", openrouter: "openrouter/auto", gateway: "anthropic/claude-sonnet-5" };
$("modelProvider").addEventListener("change", () => { $("model").value = modelDefaults[$("modelProvider").value]; });
async function loadPlugins() {
  try {
    const data = await pluginApi("GET");
    const lines = ["Codex marketplaces: " + data.marketplaces.map(m => m.name).join(", ")];
    for (const runtime of ["codex", "claude"]) {
      lines.push("\\n" + (runtime === "codex" ? "Codex" : "Claude Code") + ":");
      const found = data.capabilities.filter(c => c.runtime === runtime);
      lines.push(...(found.length ? found.map(c => "• " + c.id + " (" + c.kind + (c.kind === "mcp" ? c.direct ? ", direct" : ", delegation" : "") + ")" + (c.skills?.length ? " · skills: " + c.skills.join(", ") : "") + (c.mcpServers?.length ? " · MCP: " + c.mcpServers.join(", ") : "") + (c.scope === "project" ? " · project only" : "")) : ["None found"]));
    }
    $("pluginList").textContent = lines.join("\\n");
  } catch (e) { $("pluginList").textContent = "Could not load plugins: " + e.message; }
}
$("refreshPlugins").addEventListener("click", loadPlugins);
for (const [formId, fieldId, kind] of [["marketplaceForm", "marketplace", "marketplace"], ["pluginForm", "plugin", "plugin"]]) {
  $(formId).addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = $(formId).querySelector("button");
    button.disabled = true; status("Installing…");
    try {
      const result = await pluginApi("POST", { kind, value: $(fieldId).value.trim() });
      status(kind === "marketplace" ? "Marketplace added: " + result.marketplaceName : "Plugin installed: " + result.pluginId, "ok");
      $(fieldId).value = "";
      await loadPlugins();
    } catch (err) { status(err.message, "err"); }
    finally { button.disabled = false; }
  });
}
load();
loadPlugins();
</script>
</body>
</html>`;
