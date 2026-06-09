#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT_DIR="${ADAPTIVE_AGENT_RELEASE_DIR:-$ROOT_DIR/dist/release}"
ENTRYPOINT="$ROOT_DIR/packages/agent-sdk/src/adaptive-agent.ts"
BUILD_INFO="$ROOT_DIR/packages/agent-sdk/src/install/build-info.generated.ts"
REPOSITORY="${ADAPTIVE_AGENT_REPOSITORY:-https://github.com/ugmurthy/adaptiveAgent}"

fail() {
  printf 'build-release-assets: %s\n' "$1" >&2
  exit 1
}

command -v bun >/dev/null 2>&1 || fail 'bun is required'
command -v tar >/dev/null 2>&1 || fail 'tar is required'

TAG="${GITHUB_REF_NAME:-${ADAPTIVE_AGENT_RELEASE_TAG:-}}"
if [ -z "$TAG" ]; then
  TAG=$(git -C "$ROOT_DIR" describe --tags --exact-match 2>/dev/null || true)
fi
[ -n "$TAG" ] || fail 'release tag not found; set ADAPTIVE_AGENT_RELEASE_TAG or run from a tagged commit'
case "$TAG" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "release tag must look like vX.Y.Z or vX.Y.Z-preview.N: $TAG" ;;
esac

VERSION=${TAG#v}
COMMIT=$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD)
BUILD_TIMESTAMP=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

ORIGINAL_BUILD_INFO=$(mktemp)
cp "$BUILD_INFO" "$ORIGINAL_BUILD_INFO"
restore_build_info() {
  cp "$ORIGINAL_BUILD_INFO" "$BUILD_INFO"
  rm -f "$ORIGINAL_BUILD_INFO"
}
trap restore_build_info EXIT INT TERM

write_build_info() {
  target="$1"
  cat > "$BUILD_INFO" <<EOF
export const BUILD_INFO = {
  version: '$VERSION',
  commit: '$COMMIT',
  target: '$target',
  buildTimestamp: '$BUILD_TIMESTAMP',
  repository: '$REPOSITORY',
} as const;
EOF
}

compile_target() {
  target="$1"
  bun_target="$2"
  exe_name="$3"
  asset_name="$4"

  work_dir="$OUT_DIR/work/$target"
  rm -rf "$work_dir"
  mkdir -p "$work_dir"
  write_build_info "$target"

  printf 'Building %s\n' "$target"
  bun build "$ENTRYPOINT" \
    --compile \
    --target="$bun_target" \
    --outfile="$work_dir/$exe_name"

  if [ "${asset_name##*.}" = "zip" ]; then
    if command -v zip >/dev/null 2>&1; then
      (cd "$work_dir" && zip -q "$OUT_DIR/$asset_name" "$exe_name")
    elif command -v ditto >/dev/null 2>&1; then
      ditto -c -k --sequesterRsrc --keepParent "$work_dir/$exe_name" "$OUT_DIR/$asset_name"
    else
      fail 'zip or ditto is required to package Windows assets'
    fi
  else
    tar -czf "$OUT_DIR/$asset_name" -C "$work_dir" "$exe_name"
  fi
}

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

compile_target darwin-arm64 bun-darwin-arm64 adaptive-agent "adaptive-agent-$TAG-darwin-arm64.tar.gz"
compile_target darwin-x64 bun-darwin-x64 adaptive-agent "adaptive-agent-$TAG-darwin-x64.tar.gz"
compile_target linux-arm64 bun-linux-arm64 adaptive-agent "adaptive-agent-$TAG-linux-arm64.tar.gz"
compile_target linux-x64 bun-linux-x64 adaptive-agent "adaptive-agent-$TAG-linux-x64.tar.gz"
compile_target windows-x64 bun-windows-x64 adaptive-agent.exe "adaptive-agent-$TAG-windows-x64.zip"

cp "$ROOT_DIR/scripts/install.sh" "$OUT_DIR/install.sh"
cp "$ROOT_DIR/scripts/install.ps1" "$OUT_DIR/install.ps1"
chmod 755 "$OUT_DIR/install.sh"

(
  cd "$OUT_DIR"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 adaptive-agent-* install.sh install.ps1 > checksums.txt
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum adaptive-agent-* install.sh install.ps1 > checksums.txt
  else
    fail 'shasum or sha256sum is required'
  fi
)

rm -rf "$OUT_DIR/work"

printf 'Release assets written to %s\n' "$OUT_DIR"
ls -la "$OUT_DIR"
