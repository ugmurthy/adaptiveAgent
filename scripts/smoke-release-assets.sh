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
runtime_asset=$(find "$RELEASE_DIR" -maxdepth 1 -type f -name "adaptive-agent-runtime-v*-$platform-$cpu.tar.gz" | sort | tail -n 1)
[ -n "$runtime_asset" ] || fail "no runtime release asset found for $platform-$cpu in $RELEASE_DIR"

tmp_dir=$(mktemp -d 2>/dev/null || mktemp -d -t adaptive-agent-smoke)
trap 'rm -rf "$tmp_dir"' EXIT INT TERM

tar -xzf "$asset" -C "$tmp_dir"
binary="$tmp_dir/adaptive-agent"
[ -x "$binary" ] || fail "extracted binary is not executable: $binary"
trace_binary="$tmp_dir/trace-session"
[ -x "$trace_binary" ] || fail "extracted trace-session binary is not executable: $trace_binary"
runtime_binary="$tmp_dir/agent-runtime"
[ -x "$runtime_binary" ] || fail "extracted agent-runtime binary is not executable: $runtime_binary"

home_dir="$tmp_dir/home"
cwd_dir="$tmp_dir/workspace"
mkdir -p "$home_dir" "$cwd_dir"

"$binary" --version
"$binary" --help >/dev/null
"$trace_binary" --help >/dev/null
printf '%s\n' '{"version":1,"id":"smoke-hello","type":"hello"}' | "$runtime_binary" | grep '"id":"smoke-hello"' >/dev/null
rm -f "$runtime_binary"
tar -xzf "$runtime_asset" -C "$tmp_dir"
[ -x "$runtime_binary" ] || fail "runtime-only asset does not contain executable agent-runtime"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":"runtime-smoke-init","method":"initialize","params":{"protocolVersion":"1.10","clientInfo":{"name":"release-smoke"}}}' \
  '{"jsonrpc":"2.0","id":"runtime-smoke-version","method":"cli/execute","params":{"argv":["--version"]}}' \
  | "$runtime_binary" | grep '"id":"runtime-smoke-version".*"exitCode":0' >/dev/null
ADAPTIVE_AGENT_HOME="$home_dir" "$binary" init --dry-run --yes --cwd "$cwd_dir" >/dev/null
ADAPTIVE_AGENT_HOME="$home_dir" "$binary" init --yes --cwd "$cwd_dir" >/dev/null
ADAPTIVE_AGENT_HOME="$home_dir" "$binary" doctor --cwd "$cwd_dir" --output json >/dev/null || true

printf 'Smoke test passed for %s\n' "$asset"
