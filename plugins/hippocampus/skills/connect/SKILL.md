---
name: connect
description: Connect this agent (or another app) to a person's hosted Hippocampus memory, with their approval, or guide them through connecting it by hand. Use when someone asks to connect Hippocampus, set up memory, or when the hippocampus tools are missing.
---

# Connect to Hippocampus

Hippocampus is shared memory for a person's agents. Each connection serves **one vault**. Go step by step, in plain words.

## 1. Find the instance

Ask the person for their Hippocampus address (like `https://hippocampus.example.com`) if you don't have it. Read `<address>/llms.txt`: it says how this instance connects agents.

## 2. Choose how

- **Connect me, with your approval** (device sign-in): best when you can run commands. The person approves on their dashboard; you get a key for the vault they choose.
- **Guide them by hand:** best for an app you can't configure yourself.

## 3a. Device sign-in

1. `curl -s -X POST <address>/connect/device -d client_name="<your app's name>" -d agent=<an id for you, like claude-code>`. Add `-d access=curate` only if they asked you to be the nightly curator.
2. Show the person the `user_code` and the `verification_uri_complete` link. Ask them to open it, check the code matches, choose the vault, and approve.
3. Every `interval` seconds: `curl -s -X POST <address>/connect/token -d grant_type=urn:ietf:params:oauth:grant-type:device_code -d device_code=<device_code>`. Keep going on `authorization_pending`; slow down on `slow_down`; stop on `access_denied` or `expired_token` and tell them.
4. The answer has `access_token` (the key), `mcp_url`, `server_name` and `claude_code`, a ready `claude mcp add` line. Tell the person you're about to run it (the key will be in this session's history), then run it. Never print the key again, and never write it into a file in a repository.
5. Ask them to start a new session so the tools load, then call `onboard`.

## 3b. By hand

1. They open `<address>/dashboard/setup/` and sign in with GitHub.
2. **Connected apps → Connect an app**: pick the app, what it may do, and its name.
3. They paste the snippet it shows into that app. The key is shown once; never ask them to paste it into this chat.

## Rules

- One agent id per agent; an id another connection uses is refused.
- The curator sees secrets: suggest a separate bot that only curates (see `/hippocampus:sleep-setup`).
