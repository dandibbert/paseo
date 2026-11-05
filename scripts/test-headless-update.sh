#!/usr/bin/env bash
# Exercise installer symlink switching without GitHub downloads or a running daemon.
set -Eeuo pipefail
root="$(cd "$(dirname "$0")/.." && pwd -P)"
for s in package-headless-linux.sh smoke-headless-linux.sh paseo-headless-update.sh test-headless-update.sh; do
  bash -n "$root/scripts/$s"
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export PASEO_INSTALL_ROOT="$tmp"
export PASEO_SYSTEMD_SERVICE=paseo-headless-nonexistent-test.service
installer="$root/scripts/paseo-headless-update.sh"

for version in headless-111111111111 headless-222222222222; do
  mkdir -p "$tmp/releases/$version/bin"
  printf '#!/bin/sh\nexit 0\n' > "$tmp/releases/$version/bin/paseo"
  chmod +x "$tmp/releases/$version/bin/paseo"
done

bash "$installer" activate headless-111111111111
[[ "$(readlink "$tmp/current")" == "$tmp/releases/headless-111111111111" ]]
bash "$installer" activate headless-222222222222
[[ "$(readlink "$tmp/current")" == "$tmp/releases/headless-222222222222" ]]
[[ "$(readlink "$tmp/previous")" == "$tmp/releases/headless-111111111111" ]]
bash "$installer" rollback
[[ "$(readlink "$tmp/current")" == "$tmp/releases/headless-111111111111" ]]
[[ "$(readlink "$tmp/previous")" == "$tmp/releases/headless-222222222222" ]]
if bash "$installer" activate headless-invalid >/dev/null 2>&1; then
  echo "Malformed release name was accepted" >&2
  exit 1
fi

# A running service blocks activation unless the daemon itself performs the swap.
mkdir -p "$tmp/fake-bin"
printf '#!/bin/sh\n[ "$1" = is-active ] && exit 0\nexit 1\n' > "$tmp/fake-bin/systemctl"
chmod +x "$tmp/fake-bin/systemctl"
if PATH="$tmp/fake-bin:$PATH" bash "$installer" activate headless-222222222222 >/dev/null 2>&1; then
  echo "Activation proceeded while the service was active" >&2
  exit 1
fi
[[ "$(readlink "$tmp/current")" == "$tmp/releases/headless-111111111111" ]]
PATH="$tmp/fake-bin:$PATH" PASEO_HEADLESS_LIVE_ACTIVATE=1 \
  bash "$installer" activate headless-222222222222
[[ "$(readlink "$tmp/current")" == "$tmp/releases/headless-222222222222" ]]

bash "$installer" status
echo "Headless update/rollback helper passed."
