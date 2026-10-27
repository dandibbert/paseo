---
title: Providers
description: How Paseo thinks about coding agents, wrapping existing CLIs, native vs ACP support, and where to go next.
nav: Providers
order: 20
category: Providers
---

# Providers

Paseo runs **existing coding agents you've installed and authenticated** in workspaces with an editor, terminals, diffs, and, on desktop, a browser. Run several agents in parallel, choose a provider for each task, and review their work in the same app. Your subscriptions, config, skills, and MCP servers stay intact.

To try the workflow, [run parallel tasks in separate worktrees](/docs/parallel-development).

## Mental model

A provider is the contract between Paseo and one external agent CLI: how to launch it, how to stream its output, how to send input back, what modes it supports. The actual binary lives on your machine and runs as a normal subprocess.

## Two tiers

- **Native support**, Paseo ships a bundled adapter for the major agents (Claude Code, Codex, OpenCode, Pi, [Antigravity](/docs/supported-providers#antigravity), [Muse Code](/docs/muse-code)). Auto-discovered when the underlying CLI is installed, with mode metadata and voice support where applicable.
- **ACP catalog**, any agent speaking the [Agent Client Protocol](https://agentclientprotocol.com) is supported through a generic adapter. Paseo ships a curated catalog of one-click installs (Cursor, Gemini, GitHub Copilot, Hermes, Kimi, Qwen Code, and 25+ more), and you can add any other ACP agent yourself.

Either way, **you install the underlying CLI**. Paseo runs it.

## Update a CLI

Open **Settings → your host → Providers → provider → CLI updates** to check for a newer
version. Review the host, executable path, and command before confirming. The update runs
on that daemon host, even when you are using Paseo on your phone or another computer.

On macOS and Linux, Paseo identifies the installer from the executable actually selected
by the provider, including command and environment overrides:

- Official native updaters for Claude Code, OpenCode, Cursor, OMP, and Goose.
- Muse's installed launcher, using the synchronous installation mode provided by Meta.
- npm, pnpm, and Bun global packages, including ACP and plugin providers. Package names
  come from the installed package that owns the executable, not a provider whitelist.
- Homebrew formulae and casks, verified against the resolved Cellar or Caskroom installation.
- Version-pinned `npx` catalog commands. Paseo prepares the new package, then saves the new
  pinned launch command on the host. It does not install a different global CLI.
- An explicit `updateCommand` for custom installers. See [Custom providers](/docs/custom-providers#cli-update-commands).

Self-updaters and package managers select the target using their own channel settings.
Paseo shows the command rather than claiming an unknown target version. An exit-zero no-op
is valid when the CLI is already current. The selected installation is checked again after
updating. npm and pinned `npx` updates resolve and display a specific target version.

Antigravity's official installer provides background auto-updates, not a documented standalone
update command. Paseo does not invent one; package-managed installations or an explicitly
configured updater can still be used. Unrecognized installation layouts, system packages,
Windows, and containers require their original updater. Paseo does not use `sudo` or execute
downloaded installer scripts. Every update requires confirmation.

Wait for all running tasks, including profiles and subagents, to finish. Custom ACP entries
can share an executable without sharing a provider ID, so Paseo blocks new agent work globally
until verification finishes. Existing sessions keep their processes; start a new session to
use the updated CLI. The daemon is not restarted. If the connection drops, the host may still
be updating. Check the installed version before retrying.

Updating Paseo itself does not update provider CLIs. See [Updates](/docs/updates) for Paseo releases.

## Where to go next

- [Supported providers](/docs/supported-providers), the full list with install links.
- [Agent profiles](/docs/agent-profiles), save model, mode, and thinking settings together, with notes to guide delegation.
- [Custom providers](/docs/custom-providers), add your own provider, point an existing one at a different endpoint, configure multiple provider aliases, or override the binary in `~/.paseo/config.json`.
- [paseo.sh/agents](/agents), per-agent landing page for each supported provider.
