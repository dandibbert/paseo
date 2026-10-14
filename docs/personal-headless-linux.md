# Personal Paseo: Linux Headless on BERO (Debian 12, x86_64)

This deploys the **dandibbert/paseo** fork's own Daemon + CLI on a headless VPS. It does not install
the Electron desktop, does not install upstream npm packages in place of the fork, and does not
install agent CLIs (Codex, Claude Code, Pi) on the server. Install those separately as the
unprivileged dev user.

The archive is built by the fork's existing Docker packaging path: source-built @getpaseo workspace
tarballs, production dependencies and native addons from Debian Bookworm, plus a bundled Node 22
runtime. Every archive contains **headless-build.json** with its exact source commit.

## CI and release policy

- Relevant main and PR changes build and **boot-test** the Linux AMD64 package, including
  the bundled Web UI. Docs-only changes skip packaging. Manual builds and the
  `headless-publish` promotion branch always build. See
  [Personal fork Actions](release.md#personal-fork-actions) for the repository's trigger policy.
  The successful Actions
  run contains an artifact named paseo-headless-linux-amd64-<full GitHub SHA>, kept for 30 days.
- Nothing is deployed automatically; no running Agents are interrupted.
- For an easy-to-download, commit-pinned GitHub Release, open **Actions → Linux Headless Build and Release →
  Run workflow**, select **main**, and set **publish_release=true**. This reruns the build and
  health test before publishing the two files below in a prerelease tagged **headless-<12 hex
  SHA>**:
  - paseo-headless-linux-amd64.tar.gz
  - paseo-headless-linux-amd64.tar.gz.sha256

Alternatively, in a machine with the GitHub CLI authenticated:

```bash
gh workflow run headless-linux.yml --repo dandibbert/paseo --ref main -f publish_release=true
```

Alternatively, to publish **without `workflow_dispatch`**, push an already verified
`main` commit to the dedicated `headless-publish` branch. The branch push will
rebuild and boot-test that exact commit and publish only after success:

```bash
git fetch origin main
git push origin origin/main:refs/heads/headless-publish
```

This is an explicit opt-in release trigger, not an automatic release on
ordinary `main` pushes. Do not force-push it or point it to unreviewed code.

Releases are immutable: an existing tag will **not** be silently overwritten. This is intentionally
separate from normal macOS desktop releases and from Paseo's upstream Docker image.

## One-time setup on BERO

**As root**, prepare the dev account separately (do not change root's existing
Hermes/coding-tools-mcp or production Compose services):

```bash
apt-get update
apt-get install -y bash ca-certificates curl git python3
install -d -o dev -g dev -m 700 /home/dev/apps
```

**As dev** (e.g. SSH with your existing dev password), download the helper from the fork's main
branch **after the PR is merged**, inspect it, and stage a published release. No local build tools
or npm installation are required.

```bash
mkdir -p "$HOME/apps/paseo"
curl -fL https://raw.githubusercontent.com/dandibbert/paseo/main/scripts/paseo-headless-update.sh \
  -o "$HOME/paseo-headless-update.sh"
less "$HOME/paseo-headless-update.sh"
bash "$HOME/paseo-headless-update.sh" stage latest
bash "$HOME/paseo-headless-update.sh" activate
"$HOME/apps/paseo/current/bin/paseo" --version
cat "$HOME/apps/paseo/current/headless-build.json"
```

If **stage latest** reports that no release exists, first publish one using the Actions button
above. A successful CI Artifact alone is not a GitHub Release. The helper can use GH_TOKEN for
authenticated API calls if rate-limited.

Initialize the Daemon before making a systemd service:

```bash
PASEO="$HOME/apps/paseo/current/bin/paseo"
"$PASEO" daemon config set daemon.listen 127.0.0.1:6767 --home "$HOME/.paseo"
"$PASEO" daemon config set daemon.relay.enabled false --home "$HOME/.paseo"
"$PASEO" daemon set-password --home "$HOME/.paseo"
```

Use a strong password, even though the example listens only on loopback. Later you can enable and
configure your own Paseo Relay in this same persisted Daemon home, without changing the installed
program files.

**As root**, install the provided systemd unit and verify its paths and user. The template expects
/home/dev/apps/paseo/current and User=dev:

```bash
curl -fL https://raw.githubusercontent.com/dandibbert/paseo/main/deploy/paseo-headless/paseo-personal.service \
  -o /etc/systemd/system/paseo-personal.service
systemctl daemon-reload
systemctl enable --now paseo-personal
systemctl status paseo-personal --no-pager
journalctl -u paseo-personal -n 80 --no-pager
curl -fsS http://127.0.0.1:6767/api/health
```

The state home (/home/dev/.paseo), agent credentials (/home/dev/.codex and /home/dev/.claude),
projects (/vibe-coding/projects) and worktrees are **not** stored inside release directories. Keep
backups of them separately.

From your Mac, a first connection can use SSH port forwarding without opening port 6767 publicly:

```bash
ssh -N -L 16767:127.0.0.1:6767 dev@BERO_IP
```

Then add direct host **127.0.0.1:16767** in the Mac Paseo GUI. Once this works, switch to Paseo's
SSH host or your private Tailscale/Relay connection.

## Routine upgrades without interrupting Agents

As dev, stage the latest published release. This downloads both assets, verifies SHA256 and checks
the embedded commit before changing any symlink:

```bash
bash "$HOME/paseo-headless-update.sh" stage latest
bash "$HOME/paseo-headless-update.sh" status
```

Only once Agent work is idle, switch:

```bash
sudo systemctl stop paseo-personal
bash "$HOME/paseo-headless-update.sh" activate
sudo systemctl start paseo-personal
sudo systemctl status paseo-personal --no-pager
curl -fsS http://127.0.0.1:6767/api/health
```

If the new binary does not work, stop, switch back and start again:

```bash
sudo systemctl stop paseo-personal
bash "$HOME/paseo-headless-update.sh" rollback
sudo systemctl start paseo-personal
```

**Important:** Rollback changes only the executable version, not Daemon state. If a newer version
changes state schemas incompatibly, binary rollback alone may not recover it. Back up ~/.paseo
before risky version upgrades.

## Design constraints

- Do not run coding Agents as root or add the dev user to the docker group just to make a build
  succeed; the Docker daemon is effectively root.
- Do not expose the unauthenticated Daemon port to the public Internet.
- The packaged Node binary targets Linux amd64 with Debian 12 or newer system libraries. The BERO
  VPS itself does not need to build native npm modules.
- Keep production API containers, existing cloudflared and root MCP untouched.
- The bundle does not include Codex, Claude Code, Pi, Go, Rust or other developer toolchains.
  Install them separately in dev's PATH and verify they work from systemd's service environment.
