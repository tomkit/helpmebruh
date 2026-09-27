---
name: install-helpmebruh
description: Install, configure, verify, or repair the Help Me Bruh iMessage assistant on a Mac. Use for first-time setup, model login, macOS permissions, LaunchAgent installation, or diagnosing a failed /bruh reply.
---

# Install Help Me Bruh

Set up the repository without collecting Apple ID, ChatGPT, Claude, or API credentials in chat. Secret values stay in `.env`, provider login flows, or the macOS credential store.

## Preconditions

Confirm before changing the machine:

- macOS is running on Apple silicon.
- Messages can send and receive from the intended account.
- Node 24+ and pnpm are available, or the user authorizes installing them.
- The target directory is the Help Me Bruh repository.

Read the repository [README](../../README.md) for current commands and screenshots. Treat it as authoritative when this skill and the checked-out version differ.

## Install

1. Inspect `git status` and preserve existing work.
2. Run `pnpm install`.
3. If `.env` does not exist, copy `.env.example` to `.env`; never replace an existing `.env`.
4. Run `pnpm setup:secret`. Do not print or read the generated secret.
5. Run `pnpm typecheck` and `pnpm build` before installing services.

## Required human steps

Pause and ask the user to complete each step that is not already satisfied:

1. Sign in under **Messages → Settings → iMessage**.
2. Add the exact binary returned by `which node` under **System Settings → Privacy & Security → Full Disk Access**.
3. Run `pnpm dev`, type `/login`, choose **ChatGPT subscription**, and finish the provider login. API-backed providers are optional alternatives.
4. Open `http://localhost:2000/admin` and review the trigger, group access, model connection, coding agent, and Chrome profile.
5. Approve the macOS Automation prompt for Messages when the first reply is sent.

Do not attempt to click through account sign-in, enter credentials, or bypass a macOS privacy prompt for the user.

## Model boundary

- ChatGPT subscription through Eve/Codex is the default main model and does not need an API key.
- Claude Code Pro/Max can handle delegated coding tasks after the user signs into `claude`.
- A Claude Code subscription cannot currently serve as Eve's main model. Use an Anthropic API key or Vercel AI Gateway for a Claude main model.

## Install and verify services

After the human steps are complete:

```bash
pnpm services:install
pnpm services:status
curl -fsS http://127.0.0.1:2000/admin >/dev/null
```

Confirm both `com.helpmebruh.agent` and `com.helpmebruh.bridge` are running. Ask the user to send `/bruh ping` to themselves. Installation is complete only after the reply arrives.

## Diagnose

Check, in order:

1. `pnpm services:status`
2. `~/Library/Logs/helpmebruh-bridge.log`
3. `~/Library/Logs/helpmebruh-agent.log`
4. Node still has Full Disk Access after an upgrade or path change.
5. Messages Automation access is enabled.
6. The selected model login is active.

Restart with `pnpm services:restart` only after fixing the cause. Do not repeatedly retry messages or sign-in flows.
