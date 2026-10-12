#!/usr/bin/env bash
# Build a standalone Linux amd64 Paseo Daemon + CLI from this checkout.
# Reuse the repository's tested Docker packaging process, never upstream npm bits.
set -Eeuo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$repo_root"

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo "Requires Linux x86_64." >&2
  exit 1
fi
command -v docker >/dev/null
command -v node >/dev/null

output_dir="${1:-$repo_root/build/headless-linux}"
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd -P)"
sha="$(git rev-parse HEAD)"
version="$(node -p "require('./package.json').version")"
image_tag="paseo-headless-build:$(echo "$sha" | cut -c1-12)"
temp_dir="$(mktemp -d)"
container_id=""

cleanup() {
  if [[ -n "$container_id" ]]; then
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi
  rm -rf "$temp_dir"
}
trap cleanup EXIT

# This Dockerfile compiles every workspace from this commit and installs
# internal npm tarballs with production dependencies, including native addons.
docker build \
  --file docker/base/Dockerfile \
  --build-arg "PASEO_VERSION=$version" \
  --tag "$image_tag" \
  .

container_id="$(docker create "$image_tag")"
stage="$temp_dir/paseo-headless"
mkdir -p "$stage/bin" "$stage/lib"

# node:22-bookworm-slim is Debian 12 compatible. The shipped Node binary means
# the VPS does not need global npm or a separately managed Node installation.
docker cp "$container_id:/usr/local/bin/node" "$stage/bin/node"
docker cp "$container_id:/usr/local/lib/node_modules" "$stage/lib/node_modules"

cat > "$stage/bin/paseo" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
bin_dir="$(cd "$(dirname "$0")" && pwd -P)"
export PATH="$bin_dir:$PATH"
exec "$bin_dir/node" "$bin_dir/../lib/node_modules/@getpaseo/cli/bin/paseo" "$@"
WRAPPER
chmod 755 "$stage/bin/paseo" "$stage/bin/node"

server="$stage/lib/node_modules/@getpaseo/server/dist/scripts/supervisor-entrypoint.js"
test -f "$server" || { echo "Daemon runner missing: $server" >&2; exit 1; }
test -f "$stage/lib/node_modules/@getpaseo/cli/dist/index.js" || {
  echo "Built CLI missing from package" >&2
  exit 1
}
"$stage/bin/node" --check "$server"
"$stage/bin/paseo" --version

PASEO_BUILD_SHA="$sha" PASEO_BUILD_VERSION="$version" \
  "$stage/bin/node" -e 'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], JSON.stringify({sourceRepo:"dandibbert/paseo",sha:process.env.PASEO_BUILD_SHA,version:process.env.PASEO_BUILD_VERSION,platform:"linux",arch:"amd64",node:process.version},null,2)+"\n");' \
  "$stage/headless-build.json"

archive="$output_dir/paseo-headless-linux-amd64.tar.gz"
tar -C "$temp_dir" -czf "$archive" paseo-headless
(cd "$output_dir" && sha256sum "$(basename "$archive")" > "$(basename "$archive").sha256")
ls -lh "$archive" "$archive.sha256"
