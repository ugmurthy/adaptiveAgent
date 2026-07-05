#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
RELEASE_DIR="${ADAPTIVE_AGENT_RELEASE_DIR:-$ROOT_DIR/dist/release}"
NPM_OUT_DIR="${ADAPTIVE_AGENT_NPM_DIR:-$ROOT_DIR/dist/npm}"
NPM_SCOPE="${ADAPTIVE_AGENT_NPM_SCOPE:-@adaptive-agent}"
CLI_TEMPLATE="$ROOT_DIR/packages/cli/package.template.json"
CLI_BIN_DIR="$ROOT_DIR/packages/cli/bin"

fail() {
  printf 'build-npm-packages: %s\n' "$1" >&2
  exit 1
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

package_name() {
  suffix="$1"
  printf '%s/cli%s' "$NPM_SCOPE" "$suffix"
}

replace_tokens() {
  input="$1"
  output="$2"
  sed \
    -e "s#__CLI_PACKAGE_NAME__#$(json_escape "$(package_name '')")#g" \
    -e "s#__DARWIN_ARM64_PACKAGE_NAME__#$(json_escape "$(package_name '-darwin-arm64')")#g" \
    -e "s#__DARWIN_X64_PACKAGE_NAME__#$(json_escape "$(package_name '-darwin-x64')")#g" \
    -e "s#__LINUX_ARM64_PACKAGE_NAME__#$(json_escape "$(package_name '-linux-arm64')")#g" \
    -e "s#__LINUX_X64_PACKAGE_NAME__#$(json_escape "$(package_name '-linux-x64')")#g" \
    -e "s#__WIN32_X64_PACKAGE_NAME__#$(json_escape "$(package_name '-win32-x64')")#g" \
    -e "s#\"version\": \"0.0.0\"#\"version\": \"$(json_escape "$VERSION")\"#g" \
    -e "s#: \"0.0.0\"#: \"$(json_escape "$VERSION")\"#g" \
    "$input" > "$output"
}

write_platform_package_json() {
  package_dir="$1"
  name="$2"
  description="$3"
  os="$4"
  cpu="$5"
  files="$6"

  cat > "$package_dir/package.json" <<EOF
{
  "name": "$(json_escape "$name")",
  "version": "$(json_escape "$VERSION")",
  "description": "$(json_escape "$description")",
  "license": "MIT",
  "homepage": "https://github.com/ugmurthy/adaptiveAgent",
  "bugs": {
    "url": "https://github.com/ugmurthy/adaptiveAgent/issues"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/ugmurthy/adaptiveAgent.git"
  },
  "os": ["$os"],
  "cpu": ["$cpu"],
  "files": [$files]
}
EOF
}

extract_asset() {
  asset="$1"
  target_dir="$2"
  mkdir -p "$target_dir"

  case "$asset" in
    *.tar.gz) tar -xzf "$asset" -C "$target_dir" ;;
    *.zip)
      if command -v unzip >/dev/null 2>&1; then
        unzip -q "$asset" -d "$target_dir"
      else
        fail 'unzip is required to extract Windows npm package assets'
      fi
      ;;
    *) fail "unsupported release asset type: $asset" ;;
  esac
}

copy_unix_platform_package() {
  target="$1"
  suffix="$2"
  os="$3"
  cpu="$4"
  description="$5"
  asset="$RELEASE_DIR/adaptive-agent-$TAG-$target.tar.gz"
  [ -f "$asset" ] || fail "missing release asset: $asset"

  package_dir="$NPM_OUT_DIR/cli$suffix"
  extract_dir="$NPM_OUT_DIR/.extract/$target"
  rm -rf "$package_dir" "$extract_dir"
  mkdir -p "$package_dir/bin"
  extract_asset "$asset" "$extract_dir"

  [ -f "$extract_dir/adaptive-agent" ] || fail "$asset did not contain adaptive-agent"
  [ -f "$extract_dir/trace-session" ] || fail "$asset did not contain trace-session"
  cp "$extract_dir/adaptive-agent" "$package_dir/bin/adaptive-agent"
  cp "$extract_dir/trace-session" "$package_dir/bin/trace-session"
  chmod 755 "$package_dir/bin/adaptive-agent" "$package_dir/bin/trace-session"
  write_platform_package_json "$package_dir" "$(package_name "$suffix")" "$description" "$os" "$cpu" '"bin/adaptive-agent", "bin/trace-session"'
}

copy_windows_platform_package() {
  asset="$RELEASE_DIR/adaptive-agent-$TAG-windows-x64.zip"
  [ -f "$asset" ] || fail "missing release asset: $asset"

  package_dir="$NPM_OUT_DIR/cli-win32-x64"
  extract_dir="$NPM_OUT_DIR/.extract/windows-x64"
  rm -rf "$package_dir" "$extract_dir"
  mkdir -p "$package_dir/bin"
  extract_asset "$asset" "$extract_dir"

  [ -f "$extract_dir/adaptive-agent.exe" ] || fail "$asset did not contain adaptive-agent.exe"
  [ -f "$extract_dir/trace-session.exe" ] || fail "$asset did not contain trace-session.exe"
  cp "$extract_dir/adaptive-agent.exe" "$package_dir/bin/adaptive-agent.exe"
  cp "$extract_dir/trace-session.exe" "$package_dir/bin/trace-session.exe"
  write_platform_package_json "$package_dir" "$(package_name '-win32-x64')" 'Adaptive Agent CLI binary for Windows x64' 'win32' 'x64' '"bin/adaptive-agent.exe", "bin/trace-session.exe"'
}

write_wrapper_package() {
  package_dir="$NPM_OUT_DIR/cli"
  rm -rf "$package_dir"
  mkdir -p "$package_dir/bin"
  replace_tokens "$CLI_TEMPLATE" "$package_dir/package.json"
  replace_tokens "$CLI_BIN_DIR/adaptive-agent.js" "$package_dir/bin/adaptive-agent.js"
  replace_tokens "$CLI_BIN_DIR/trace-session.js" "$package_dir/bin/trace-session.js"
  chmod 755 "$package_dir/bin/adaptive-agent.js" "$package_dir/bin/trace-session.js"
}

TAG="${GITHUB_REF_NAME:-${ADAPTIVE_AGENT_RELEASE_TAG:-}}"
[ -n "$TAG" ] || fail 'release tag not found; set ADAPTIVE_AGENT_RELEASE_TAG or GITHUB_REF_NAME'
case "$TAG" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "release tag must look like vX.Y.Z or vX.Y.Z-preview.N: $TAG" ;;
esac
VERSION=${TAG#v}

[ -f "$CLI_TEMPLATE" ] || fail "missing CLI package template: $CLI_TEMPLATE"
[ -f "$CLI_BIN_DIR/adaptive-agent.js" ] || fail "missing wrapper bin script: $CLI_BIN_DIR/adaptive-agent.js"
[ -f "$CLI_BIN_DIR/trace-session.js" ] || fail "missing wrapper bin script: $CLI_BIN_DIR/trace-session.js"

rm -rf "$NPM_OUT_DIR"
mkdir -p "$NPM_OUT_DIR/.extract"

copy_unix_platform_package darwin-arm64 -darwin-arm64 darwin arm64 'Adaptive Agent CLI binary for macOS arm64'
copy_unix_platform_package darwin-x64 -darwin-x64 darwin x64 'Adaptive Agent CLI binary for macOS x64'
copy_unix_platform_package linux-arm64 -linux-arm64 linux arm64 'Adaptive Agent CLI binary for Linux arm64'
copy_unix_platform_package linux-x64 -linux-x64 linux x64 'Adaptive Agent CLI binary for Linux x64'
copy_windows_platform_package
write_wrapper_package

rm -rf "$NPM_OUT_DIR/.extract"

if command -v npm >/dev/null 2>&1; then
  for dir in \
    "$NPM_OUT_DIR/cli-darwin-arm64" \
    "$NPM_OUT_DIR/cli-darwin-x64" \
    "$NPM_OUT_DIR/cli-linux-arm64" \
    "$NPM_OUT_DIR/cli-linux-x64" \
    "$NPM_OUT_DIR/cli-win32-x64" \
    "$NPM_OUT_DIR/cli"
  do
    (cd "$dir" && npm pack --dry-run >/dev/null 2>&1)
  done
else
  printf 'build-npm-packages: npm not found; skipping npm pack --dry-run validation\n' >&2
fi

printf 'npm packages written to %s\n' "$NPM_OUT_DIR"
find "$NPM_OUT_DIR" -maxdepth 2 -type f | sort
