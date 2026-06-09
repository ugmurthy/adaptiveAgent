#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
RELEASE_DIR="${ADAPTIVE_AGENT_RELEASE_DIR:-$ROOT_DIR/dist/release}"

fail() {
  printf 'smoke-release-assets: %s\n' "$1" >&2
  exit 1
}

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

asset=$(find "$RELEASE_DIR" -maxdepth 1 -type f -name "adaptive-agent-v*-$platform-$cpu.tar.gz" | sort | tail -n 1)
[ -n "$asset" ] || fail "no release asset found for $platform-$cpu in $RELEASE_DIR"

tmp_dir=$(mktemp -d 2>/dev/null || mktemp -d -t adaptive-agent-smoke)
trap 'rm -rf "$tmp_dir"' EXIT INT TERM

tar -xzf "$asset" -C "$tmp_dir"
binary="$tmp_dir/adaptive-agent"
[ -x "$binary" ] || fail "extracted binary is not executable: $binary"

home_dir="$tmp_dir/home"
cwd_dir="$tmp_dir/workspace"
mkdir -p "$home_dir" "$cwd_dir"

"$binary" --version
"$binary" --help >/dev/null
ADAPTIVE_AGENT_HOME="$home_dir" "$binary" init --dry-run --yes --cwd "$cwd_dir" >/dev/null
ADAPTIVE_AGENT_HOME="$home_dir" "$binary" init --yes --cwd "$cwd_dir" >/dev/null
ADAPTIVE_AGENT_HOME="$home_dir" "$binary" doctor --cwd "$cwd_dir" --output json >/dev/null || true

printf 'Smoke test passed for %s\n' "$asset"
