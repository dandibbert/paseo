#!/usr/bin/env bash
# Extract the actual release TAR and prove that its bundled Node boots Paseo.
set -Eeuo pipefail

archive="${1:?Usage: smoke-headless-linux.sh <paseo-headless-linux-amd64.tar.gz>}"
tmp="$(mktemp -d)"
daemon_pid=""
cleanup() {
  if [[ -n "$daemon_pid" ]]; then
    kill "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

tar -xzf "$archive" -C "$tmp"
paseo="$tmp/paseo-headless/bin/paseo"
test -x "$paseo"
test -f "$tmp/paseo-headless/lib/node_modules/@getpaseo/server/dist/scripts/supervisor-entrypoint.js"
"$paseo" --version

mkdir -p "$tmp/home"
export HOME="$tmp/home"
export PASEO_HOME="$HOME/.paseo"
export PASEO_LISTEN=127.0.0.1:18677
export PASEO_RELAY_ENABLED=false
export PASEO_WEB_UI_ENABLED=false
export PASEO_PASSWORD=headless-package-smoke-only
export PATH="$tmp/paseo-headless/bin:$PATH"

"$paseo" daemon run --home "$PASEO_HOME" > "$tmp/daemon.log" 2>&1 &
daemon_pid="$!"

ready=false
for _ in $(seq 1 90); do
  if curl --silent --show-error --fail --max-time 2 http://127.0.0.1:18677/api/health > /dev/null 2>&1; then
    ready=true
    break
  fi
  if ! kill -0 "$daemon_pid" 2>/dev/null; then
    break
  fi
  sleep 1
done

if [[ "$ready" != true ]]; then
  echo "Paseo headless daemon failed startup/health smoke test" >&2
  tail -n 100 "$tmp/daemon.log" >&2 || true
  exit 1
fi

echo "Paseo Linux Headless archive booted successfully; /api/health is healthy."
