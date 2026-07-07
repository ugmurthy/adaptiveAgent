#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NPM_OUT_DIR="${ADAPTIVE_AGENT_NPM_DIR:-$ROOT_DIR/dist/npm}"
NPM_SCOPE="${ADAPTIVE_AGENT_NPM_SCOPE:-@adaptive-agent}"
SKIP_EXISTING="${ADAPTIVE_AGENT_NPM_SKIP_EXISTING:-1}"
PUBLISH_ARGS="${ADAPTIVE_AGENT_NPM_PUBLISH_ARGS:---access public}"
NPM_OTP="${ADAPTIVE_AGENT_NPM_OTP:-}"
TEMP_NPMRC=""

fail() {
  printf 'publish-npm-packages: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  if [ -n "$TEMP_NPMRC" ]; then
    rm -f "$TEMP_NPMRC"
  fi
}

trap cleanup EXIT INT TERM

package_name() {
  suffix="$1"
  printf '%s/cli%s' "$NPM_SCOPE" "$suffix"
}

package_exists() {
  name="$1"
  version="$2"
  npm view "$name@$version" version >/dev/null 2>&1
}

package_field() {
  dir="$1"
  field="$2"
  node -e 'const pkg = require(`${process.argv[1]}/package.json`); const value = pkg[process.argv[2]]; if (typeof value === "string") process.stdout.write(value);' "$dir" "$field"
}

validate_package() {
  dir="$1"
  expected_name="$2"
  [ -d "$dir" ] || fail "missing npm package dir: $dir"

  actual_name=$(package_field "$dir" name)
  actual_version=$(package_field "$dir" version)
  [ "$actual_name" = "$expected_name" ] || fail "package name mismatch in $dir: expected $expected_name, found $actual_name. Re-run scripts/build-npm-packages.sh with the same ADAPTIVE_AGENT_NPM_SCOPE."
  [ "$actual_version" = "$VERSION" ] || fail "package version mismatch in $dir: expected $VERSION, found $actual_version. Re-run scripts/build-npm-packages.sh for $TAG."
}

publish_failed_scope_message() {
  name="$1"
  user="$2"
  case "$name" in
    @*/*)
      scope=${name%%/*}
      printf '\n%s\n' "npm returned 404 while publishing $name. For new scoped packages, npm uses 404 when the scope does not exist or your account/token cannot publish to it."
      printf '%s\n' "Current npm user: ${user:-unknown}"
      printf '%s\n' "Requested scope: $scope"
      if [ -n "$user" ] && [ "$scope" != "@$user" ]; then
        printf '%s\n' "Either create/grant access to the npm org scope ${scope#@}, or rebuild and publish with ADAPTIVE_AGENT_NPM_SCOPE=@$user."
      else
        printf '%s\n' "Make sure this scope exists on npm and that your token has publish permission."
      fi
      ;;
  esac
}

preflight_scope_access() {
  case "$NPM_SCOPE" in
    @*) ;;
    *) return 0 ;;
  esac

  org=${NPM_SCOPE#@}
  org_log=$(mktemp 2>/dev/null || mktemp -t adaptive-agent-npm-org)
  if npm org ls "$org" > "$org_log" 2>&1; then
    if ! grep -Eq "(^|[[:space:]])$NPM_USER([[:space:]]|$)" "$org_log"; then
      cat "$org_log" >&2
      rm -f "$org_log"
      fail "npm user $NPM_USER can see @$org but is not listed as an org member. Add this user to the npm org or use a token from an org member."
    fi
    rm -f "$org_log"
    return 0
  fi

  cat "$org_log" >&2
  rm -f "$org_log"
  fail "npm user $NPM_USER cannot list @$org. Run 'npm login' with an org member account, create a token with access to @$org, or use ADAPTIVE_AGENT_NPM_SCOPE=@$NPM_USER."
}

configure_node_auth_token() {
  [ -n "${NODE_AUTH_TOKEN:-}" ] || return 0

  if [ -n "${NPM_CONFIG_REGISTRY:-}" ]; then
    registry="$NPM_CONFIG_REGISTRY"
  else
    registry=$(npm config get registry 2>/dev/null || printf 'https://registry.npmjs.org/')
  fi
  registry_auth_path=$(printf '%s' "$registry" | sed -E 's#^https?://##; s#/*$#/#')
  [ -n "$registry_auth_path" ] || fail 'unable to resolve npm registry for NODE_AUTH_TOKEN'

  TEMP_NPMRC=$(mktemp 2>/dev/null || mktemp -t adaptive-agent-npmrc)
  chmod 600 "$TEMP_NPMRC"
  {
    printf 'registry=%s\n' "$registry"
    printf '//%s:_authToken=%s\n' "$registry_auth_path" "$NODE_AUTH_TOKEN"
    printf 'always-auth=true\n'
  } > "$TEMP_NPMRC"
  export NPM_CONFIG_USERCONFIG="$TEMP_NPMRC"
}

run_npm_publish() {
  dir="$1"
  log="$2"
  if [ -n "$NPM_OTP" ]; then
    npm publish "$dir" $PUBLISH_ARGS --otp="$NPM_OTP" > "$log" 2>&1
  else
    npm publish "$dir" $PUBLISH_ARGS > "$log" 2>&1
  fi
}

print_otp_guidance() {
  cat >&2 <<'EOF'
npm publish uses a 6-digit TOTP as the publish-time 2FA challenge when your account has 2FA enabled for authorization and publishing.
The npm CLI cannot complete npm's browser, passkey, or security-key 2FA flow from this shell script.
To publish without OTP prompts, create an npm automation token with publish access to the scope and run with NODE_AUTH_TOKEN=<token>.
For manual publishing, add an authenticator app to npm and enter its current 6-digit TOTP code when prompted.
EOF
}

prompt_for_otp() {
  name="$1"
  if [ ! -t 0 ]; then
    print_otp_guidance
    fail "npm requires a one-time password to publish $name. Re-run with ADAPTIVE_AGENT_NPM_OTP=<totp-code>, or use NODE_AUTH_TOKEN=<automation-token>."
  fi

  print_otp_guidance
  printf 'Enter npm TOTP for %s: ' "$name" >&2
  IFS= read -r NPM_OTP
  [ -n "$NPM_OTP" ] || fail 'npm TOTP was empty'
}

publish_package() {
  dir="$1"
  name="$2"
  validate_package "$dir" "$name"

  if [ "$SKIP_EXISTING" = "1" ] && package_exists "$name" "$VERSION"; then
    printf 'Skipping %s@%s because it already exists on npm\n' "$name" "$VERSION"
    return 0
  fi

  publish_log=$(mktemp 2>/dev/null || mktemp -t adaptive-agent-npm-publish)
  attempt=1
  while [ "$attempt" -le 3 ]; do
    if run_npm_publish "$dir" "$publish_log"; then
      cat "$publish_log"
      rm -f "$publish_log"
      return 0
    fi

    if grep -q 'EOTP\|one-time password' "$publish_log"; then
      printf 'npm requested or rejected the publish-time TOTP for %s.\n' "$name" >&2
      prompt_for_otp "$name"
      attempt=$((attempt + 1))
      : > "$publish_log"
      continue
    fi

    cat "$publish_log" >&2
    if grep -q 'E404\|404 Not Found' "$publish_log"; then
      publish_failed_scope_message "$name" "$NPM_USER" >&2
    fi
    rm -f "$publish_log"
    fail "npm publish failed for $name@$VERSION"
  done

  cat "$publish_log" >&2
  rm -f "$publish_log"
  fail "npm publish failed for $name@$VERSION after multiple OTP attempts"
}

command -v npm >/dev/null 2>&1 || fail 'npm is required'
command -v node >/dev/null 2>&1 || fail 'node is required'

configure_node_auth_token

NPM_USER=$(npm whoami 2>/dev/null || true)
[ -n "$NPM_USER" ] || fail 'npm is not authenticated. Run npm login locally, or set NODE_AUTH_TOKEN in CI.'

TAG="${GITHUB_REF_NAME:-${ADAPTIVE_AGENT_RELEASE_TAG:-}}"
[ -n "$TAG" ] || fail 'release tag not found; set ADAPTIVE_AGENT_RELEASE_TAG or GITHUB_REF_NAME'
case "$TAG" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "release tag must look like vX.Y.Z or vX.Y.Z-preview.N: $TAG" ;;
esac
VERSION=${TAG#v}

preflight_scope_access

publish_package "$NPM_OUT_DIR/cli-darwin-arm64" "$(package_name '-darwin-arm64')"
publish_package "$NPM_OUT_DIR/cli-darwin-x64" "$(package_name '-darwin-x64')"
publish_package "$NPM_OUT_DIR/cli-linux-arm64" "$(package_name '-linux-arm64')"
publish_package "$NPM_OUT_DIR/cli-linux-x64" "$(package_name '-linux-x64')"
publish_package "$NPM_OUT_DIR/cli-win32-x64" "$(package_name '-win32-x64')"
publish_package "$NPM_OUT_DIR/cli" "$(package_name '')"
