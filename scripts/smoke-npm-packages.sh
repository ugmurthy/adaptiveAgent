#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NPM_OUT_DIR="${ADAPTIVE_AGENT_NPM_DIR:-$ROOT_DIR/dist/npm}"
NPM_SCOPE="${ADAPTIVE_AGENT_NPM_SCOPE:-@adaptive-agent}"

fail() {
  printf 'smoke-npm-packages: %s\n' "$1" >&2
  exit 1
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

package_name() {
  suffix="$1"
  printf '%s/cli%s' "$NPM_SCOPE" "$suffix"
}

command -v npm >/dev/null 2>&1 || fail 'npm is required'

os=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')
arch=$(uname -m 2>/dev/null)

case "$os" in
  darwin) platform="darwin" ;;
  linux) platform="linux" ;;
  *) fail "unsupported smoke-test OS: $os" ;;
esac

case "$arch" in
  arm64|aarch64) cpu="arm64" ;;
  x86_64|amd64) cpu="x64" ;;
  *) fail "unsupported smoke-test architecture: $arch" ;;
esac

suffix="-$platform-$cpu"
wrapper_dir="$NPM_OUT_DIR/cli"
platform_dir="$NPM_OUT_DIR/cli$suffix"
[ -d "$wrapper_dir" ] || fail "missing wrapper package dir: $wrapper_dir"
[ -d "$platform_dir" ] || fail "missing platform package dir: $platform_dir"

tmp_dir=$(mktemp -d 2>/dev/null || mktemp -d -t adaptive-agent-npm-smoke)
trap 'rm -rf "$tmp_dir"' EXIT INT TERM

pack_dir="$tmp_dir/packs"
mkdir -p "$pack_dir"
wrapper_pack=$(cd "$wrapper_dir" && npm pack --pack-destination "$pack_dir" --silent)
platform_pack=$(cd "$platform_dir" && npm pack --pack-destination "$pack_dir" --silent)

cat > "$tmp_dir/package.json" <<EOF
{
  "private": true,
  "dependencies": {
    "$(json_escape "$(package_name '')")": "file:$pack_dir/$wrapper_pack",
    "$(json_escape "$(package_name "$suffix")")": "file:$pack_dir/$platform_pack"
  }
}
EOF

(cd "$tmp_dir" && npm install --ignore-scripts --silent)
"$tmp_dir/node_modules/.bin/adaptive-agent" --version
"$tmp_dir/node_modules/.bin/adaptive-agent" --help >/dev/null
"$tmp_dir/node_modules/.bin/trace-session" --help >/dev/null

printf 'npm package smoke test passed for %s\n' "$platform-$cpu"
