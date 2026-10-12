#!/usr/bin/env bash
# Non-destructive installer for headless Paseo releases; never restarts sessions.
set -Eeuo pipefail

repo="${PASEO_GITHUB_REPO:-dandibbert/paseo}"
root="${PASEO_INSTALL_ROOT:-$HOME/apps/paseo}"
service="${PASEO_SYSTEMD_SERVICE:-paseo-personal.service}"
archive=paseo-headless-linux-amd64.tar.gz

die() { echo "paseo-headless: $*" >&2; exit 1; }
usage() {
  cat <<'HELP'
Usage: bash paseo-headless-update.sh stage [latest|headless-<12 hex chars>]
       bash paseo-headless-update.sh activate [headless-<12 hex chars>]
       bash paseo-headless-update.sh rollback
       bash paseo-headless-update.sh status

Stage downloads and verifies the release without touching live sessions.
Before activate/rollback, stop Paseo after all agents are idle:
  sudo systemctl stop paseo-personal
Then activate (or rollback) and start:
  sudo systemctl start paseo-personal
PASEO_INSTALL_ROOT, PASEO_GITHUB_REPO and PASEO_SYSTEMD_SERVICE override defaults.
HELP
}

[[ "$#" -gt 0 ]] || { usage; exit 2; }
for cmd in curl python3 sha256sum; do command -v "$cmd" >/dev/null || die "$cmd is required"; done
mkdir -p "$root/releases"
root="$(cd "$root" && pwd -P)"

github_curl() {
  local headers=(-H "Accept: application/vnd.github+json")
  if [[ -n "${GH_TOKEN:-}" ]]; then
    headers+=(-H "Authorization: Bearer $GH_TOKEN")
  fi
  curl --fail --location --silent --show-error --retry 3 \
    --connect-timeout 15 --max-time 180 "${headers[@]}" "$@"
}
latest_tag() {
  github_curl "https://api.github.com/repos/$repo/releases?per_page=100" |
    python3 -c '
import json, re, sys
items=[(x.get("published_at") or "",x["tag_name"]) for x in json.load(sys.stdin)
       if not x.get("draft") and re.fullmatch(r"headless-[0-9a-f]{12}",x.get("tag_name",""))
       and {"paseo-headless-linux-amd64.tar.gz","paseo-headless-linux-amd64.tar.gz.sha256"}.issubset({a.get("name") for a in x.get("assets",[])})]
if not items: sys.exit("No headless release found: run the workflow on main with publish_release=true.")
print(max(items)[1])
'
}
validate_tag() {
  [[ "$1" =~ ^headless-[0-9a-f]{12}$ ]] || die "Invalid tag: $1"
}
read_link() {
  if [[ -L "$root/$1" ]]; then readlink "$root/$1"; fi
}
update_link() {
  local tmp="$root/.$1.$$"
  [[ ! -e "$root/$1" || -L "$root/$1" ]] || die "$root/$1 is not a symlink"
  ln -s "$2" "$tmp"
  mv -Tf "$tmp" "$root/$1"
}
ensure_stopped() {
  if command -v systemctl >/dev/null && systemctl is-active --quiet "$service"; then
    die "$service is still active; check Agent activity, then: sudo systemctl stop $service"
  fi
}

stage() {
  local tag="${1:-latest}" target tmp base
  [[ "$tag" == latest ]] && tag="$(latest_tag)"
  validate_tag "$tag"
  target="$root/releases/$tag"
  if [[ ! -d "$target" ]]; then
    tmp="$(mktemp -d "$root/releases/.download.XXXXXXXX")"
    trap 'rm -rf "$tmp"' EXIT
    base="https://github.com/$repo/releases/download/$tag"
    github_curl -o "$tmp/$archive" "$base/$archive"
    github_curl -o "$tmp/$archive.sha256" "$base/$archive.sha256"
    (cd "$tmp" && sha256sum -c "$archive.sha256") || die "SHA256 mismatch"
    if ! tar -tzf "$tmp/$archive" |
      awk '$0 !~ /^paseo-headless(\/|$)/ || $0 ~ /(^|\/)\.\.(\/|$)/ {bad=1} END {exit bad}'; then
      die "Unexpected path inside archive"
    fi
    tar --no-same-owner -xzf "$tmp/$archive" -C "$tmp"
    [[ -x "$tmp/paseo-headless/bin/paseo" ]] || die "Paseo launcher missing"
    "$tmp/paseo-headless/bin/node" -e '
const x=require(process.argv[1]);
if("headless-"+x.sha.slice(0,12)!==process.argv[2] || x.arch!=="amd64" || x.platform!=="linux")process.exit(1);
' "$tmp/paseo-headless/headless-build.json" "$tag" || die "Metadata/tag mismatch"
    "$tmp/paseo-headless/bin/paseo" --version
    mv "$tmp/paseo-headless" "$target"
    rm -rf "$tmp"
    trap - EXIT
  fi
  update_link staged "$target"
  echo "Staged $tag without interrupting the running Daemon."
  echo "Next: stop $service, then run 'bash $0 activate', then start $service."
}

activate() {
  ensure_stopped
  local tag="${1:-}" target old
  if [[ -z "$tag" ]]; then
    target="$(read_link staged)"
    [[ -n "$target" ]] || die "Nothing staged. Run stage first."
    tag="$(basename "$target")"
  else
    validate_tag "$tag"
    target="$root/releases/$tag"
  fi
  validate_tag "$tag"
  [[ -x "$target/bin/paseo" ]] || die "Release $tag has not been staged"
  old="$(read_link current)"
  if [[ -n "$old" && "$old" != "$target" ]]; then update_link previous "$old"; fi
  update_link current "$target"
  echo "Activated $tag. Start the service manually: sudo systemctl start $service"
}

rollback() {
  ensure_stopped
  local previous current
  previous="$(read_link previous)"
  [[ -n "$previous" && -x "$previous/bin/paseo" ]] || die "No previous release to restore"
  current="$(read_link current)"
  update_link current "$previous"
  if [[ -n "$current" ]]; then update_link previous "$current"; fi
  echo "Rolled back to $(basename "$previous"). Start manually: sudo systemctl start $service"
}

case "$1" in
  stage) stage "${2:-latest}" ;;
  activate) activate "${2:-}" ;;
  rollback) rollback ;;
  status)
    echo "Install root: $root"
    echo "Current: $(read_link current)"
    echo "Staged: $(read_link staged)"
    echo "Previous: $(read_link previous)"
    if command -v systemctl >/dev/null; then
      echo "Service: $(systemctl is-active "$service" 2>/dev/null || true)"
    fi
    ;;
  help|-h|--help) usage ;;
  *) usage; exit 2 ;;
esac
