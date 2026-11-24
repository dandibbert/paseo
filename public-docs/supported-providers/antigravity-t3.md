---
title: Antigravity via T3
description: Run Antigravity in Paseo through your T3 Code server.
nav: Antigravity via T3
order: 24
category: Providers
---

# Antigravity via T3

Run Antigravity through a [T3 Code](https://github.com/pingdotgg/t3code) server on your daemon host. T3 starts and drives Antigravity with its own integration; Paseo connects to T3 as one more client, the way T3's web and mobile apps do, and never starts `agy` itself.

## Getting started

1. Install the `t3` CLI and start its server for the same user that runs the Paseo daemon (`t3 service install` keeps it running).
2. In T3, sign in to Antigravity. Each Antigravity account you add in T3 appears in Paseo.
3. In Paseo, select **Antigravity (via T3)**.

On first use Paseo runs `t3 pair --label Paseo` and exchanges the one-time token for a session limited to reading and sending to threads. T3 lists it as **Paseo** under its connected clients; revoke it there to disconnect Paseo. The session is stored in `~/.paseo/t3-provider/credentials.json`, readable only by your user. When it expires or T3 revokes it, Paseo pairs again.

For a T3 server on another machine, run `t3 pair --label Paseo` there and give Paseo the pairing URL it prints:

```json
{
  "agents": {
    "providers": {
      "antigravity-t3": {
        "env": { "T3_PAIRING_URL": "https://my-server:3773/pair#token=…" }
      }
    }
  }
}
```

## What you get

Each Paseo chat is a T3 thread in a T3 project rooted at the chat's working directory. Models are listed per T3 account (`Model · Account`); choose the account by choosing the model. Paseo never switches accounts on its own.

Assistant text, reasoning, commands, file changes, searches, todos, subagents, compaction, approvals, questions and secret requests appear in Paseo. Each turn's tokens (input, cache reads, output) and the context window come from T3, and account quota does too. T3 features outside the chat itself, such as checkpoints, forks, handoffs and device previews, stay in T3; the same thread is open there.

## Turn off direct `agy` use

The direct [Antigravity](/docs/supported-providers/antigravity) provider is off until you add it: **Settings → Providers → Add provider → Antigravity**. While it is off, Paseo does not start `agy` for chats or for its usage readout. To turn it off again, open **Antigravity** in **Settings → Providers** and remove it.
