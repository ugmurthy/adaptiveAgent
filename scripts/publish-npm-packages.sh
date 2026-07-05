#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NPM_OUT_DIR="${ADAPTIVE_AGENT_NPM_DIR:-$ROOT_DIR/dist/npm}"
NPM_SCOPE="${ADAPTIVE_AGENT_NPM_SCOPE:-@adaptive-agent}"
SKIP_EXISTING="${ADAPTIVE_AGENT_NPM_SKIP_EXISTING:-1}"
PUBLISH_ARGS="${ADAPTIVE_AGENT_NPM_PUBLISH_ARGS:---access public}"

fail() {
  printf 'publish-npm-packages: %s\n' "$1" >&2
  exit 1
}

package_name() {
  suffix="$1"
  printf '%s/cli%s' "$NPM_SCOPE" "$suffix"
}

package_exists() {
  name="$1"
  version="$2"
  npm view "$name@$version" version >/dev/null 2>&1
}

publish_package() {
  dir="$1"
  name="$2"
  [ -d "$dir" ] || fail "missing npm package dir: $dir"

  if [ "$SKIP_EXISTING" = "1" ] && package_exists "$name" "$VERSION"; then
    printf 'Skipping %s@%s because it already exists on npm\n' "$name" "$VERSION"
    return 0
  fi

  # shellcheck disable=SC2086
  npm publish "$dir" $PUBLISH_ARGS
}

command -v npm >/dev/null 2>&1 || fail 'npm is required'

TAG="${GITHUB_REF_NAME:-${ADAPTIVE_AGENT_RELEASE_TAG:-}}"
[ -n "$TAG" ] || fail 'release tag not found; set ADAPTIVE_AGENT_RELEASE_TAG or GITHUB_REF_NAME'
case "$TAG" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "release tag must look like vX.Y.Z or vX.Y.Z-preview.N: $TAG" ;;
esac
VERSION=${TAG#v}

publish_package "$NPM_OUT_DIR/cli-darwin-arm64" "$(package_name '-darwin-arm64')"
publish_package "$NPM_OUT_DIR/cli-darwin-x64" "$(package_name '-darwin-x64')"
publish_package "$NPM_OUT_DIR/cli-linux-arm64" "$(package_name '-linux-arm64')"
publish_package "$NPM_OUT_DIR/cli-linux-x64" "$(package_name '-linux-x64')"
publish_package "$NPM_OUT_DIR/cli-win32-x64" "$(package_name '-win32-x64')"
publish_package "$NPM_OUT_DIR/cli" "$(package_name '')"
