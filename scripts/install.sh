#!/usr/bin/env sh
set -eu

REPO_URL="${ADAPTIVE_AGENT_REPO_URL:-https://github.com/ugmurthy/adaptiveAgent}"
INSTALL_DIR="${ADAPTIVE_AGENT_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${ADAPTIVE_AGENT_VERSION:-}"

fail() {
  printf 'adaptive-agent install: %s\n' "$1" >&2
  exit 1
}

detect_target() {
  os=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m 2>/dev/null)

  case "$os" in
    darwin) platform="darwin" ;;
    linux) platform="linux" ;;
    *) fail "unsupported operating system: $os" ;;
  esac

  case "$arch" in
    arm64|aarch64) cpu="arm64" ;;
    x86_64|amd64) cpu="x64" ;;
    *) fail "unsupported CPU architecture: $arch" ;;
  esac

  target="$platform-$cpu"
}

repo_slug() {
  printf '%s' "$REPO_URL" | sed -E 's#^https://github.com/##; s#/$##'
}

fetch_text() {
  url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-delay 1 "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$url"
  else
    fail 'required command not found: curl or wget'
  fi
}

resolve_version() {
  if [ -n "$VERSION" ]; then
    case "$VERSION" in
      v*) printf '%s' "$VERSION" ;;
      *) printf 'v%s' "$VERSION" ;;
    esac
    return 0
  fi

  slug=$(repo_slug)
  tag=$(fetch_text "https://api.github.com/repos/$slug/releases/latest" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$tag" ] || fail 'unable to resolve latest GitHub Release tag'
  printf '%s' "$tag"
}

download() {
  url="$1"
  out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-delay 1 -o "$out" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$out" "$url"
  else
    fail 'required command not found: curl or wget'
  fi
}

expected_sha256() {
  checksum_file="$1"
  asset_name="$2"
  awk -v asset="$asset_name" '$0 ~ asset { print $1; exit }' "$checksum_file"
}

actual_sha256() {
  file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{ print $1 }'
  else
    fail 'required command not found: sha256sum or shasum'
  fi
}

verify_checksum() {
  archive="$1"
  checksum_file="$2"
  asset_name="$3"
  expected=$(expected_sha256 "$checksum_file" "$asset_name")
  [ -n "$expected" ] || fail "checksum for $asset_name not found in checksums.txt"
  actual=$(actual_sha256 "$archive")
  [ "$expected" = "$actual" ] || fail "checksum mismatch for $asset_name"
}

print_path_instructions() {
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) return 0 ;;
  esac

  printf '\n%s\n' "adaptive-agent was installed to $INSTALL_DIR, which is not on PATH."
  printf '%s\n' 'Copy and run the command for your shell:'
  shell_name=$(basename "${SHELL:-sh}")
  case "$shell_name" in
    zsh)
      printf '  export PATH="%s:$PATH"\n' "$INSTALL_DIR"
      printf '  echo '\''export PATH="%s:$PATH"'\'' >> ~/.zshrc\n' "$INSTALL_DIR"
      ;;
    bash)
      printf '  export PATH="%s:$PATH"\n' "$INSTALL_DIR"
      printf '  echo '\''export PATH="%s:$PATH"'\'' >> ~/.bashrc\n' "$INSTALL_DIR"
      ;;
    fish)
      printf '  fish_add_path "%s"\n' "$INSTALL_DIR"
      ;;
    *)
      printf '  export PATH="%s:$PATH"\n' "$INSTALL_DIR"
      ;;
  esac
}

main() {
  detect_target
  tag=$(resolve_version)
  base_url="$REPO_URL/releases/download/$tag"
  asset="adaptive-agent-$tag-$target.tar.gz"

  archive_url="$base_url/$asset"
  checksum_url="$base_url/checksums.txt"

  tmp_dir=$(mktemp -d 2>/dev/null || mktemp -d -t adaptive-agent)
  trap 'rm -rf "$tmp_dir"' EXIT INT TERM

  archive="$tmp_dir/$asset"
  checksums="$tmp_dir/checksums.txt"

  printf 'Installing adaptive-agent for %s\n' "$target"
  printf 'Downloading %s\n' "$archive_url"
  download "$archive_url" "$archive"
  download "$checksum_url" "$checksums"
  verify_checksum "$archive" "$checksums" "$asset"

  extract_dir="$tmp_dir/extract"
  mkdir -p "$extract_dir"
  tar -xzf "$archive" -C "$extract_dir"

  binary="$extract_dir/adaptive-agent"
  if [ ! -f "$binary" ]; then
    binary=$(find "$extract_dir" -type f -name adaptive-agent -perm -u+x | head -n 1 || true)
  fi
  [ -n "$binary" ] && [ -f "$binary" ] || fail 'archive did not contain adaptive-agent binary'

  mkdir -p "$INSTALL_DIR"
  install_path="$INSTALL_DIR/adaptive-agent"
  tmp_install="$INSTALL_DIR/.adaptive-agent.tmp.$$"
  cp "$binary" "$tmp_install"
  chmod 755 "$tmp_install"
  mv "$tmp_install" "$install_path"

  printf 'Installed %s\n' "$install_path"
  print_path_instructions
  "$install_path" --version
}

main "$@"
