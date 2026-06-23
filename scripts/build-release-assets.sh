#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT_DIR="${ADAPTIVE_AGENT_RELEASE_DIR:-$ROOT_DIR/dist/release}"
ADAPTIVE_AGENT_ENTRYPOINT="$ROOT_DIR/packages/agent-sdk/src/adaptive-agent.ts"
TRACE_SESSION_ENTRYPOINT="$ROOT_DIR/packages/trace-session/src/trace-session.ts"
BUILD_INFO="$ROOT_DIR/packages/agent-sdk/src/install/build-info.generated.ts"
BUNDLED_ASSETS="$ROOT_DIR/packages/agent-sdk/src/install/bundled-assets.generated.ts"
REPOSITORY="${ADAPTIVE_AGENT_REPOSITORY:-https://github.com/ugmurthy/adaptiveAgent}"
# Optional build-time assets to compile into the init `core` bundle.
# - Agent dir: top-level *.json files. The release build injects the current
#   init provider/model at install time, so source agent `model` fields are
#   ignored when embedded.
# - Skill dir: immediate child directories containing SKILL.md. Files under
#   each skill directory are embedded as UTF-8 text.
CORE_BUNDLE_AGENTS_DIR="${ADAPTIVE_AGENT_CORE_BUNDLE_AGENTS_DIR:-$ROOT_DIR/packages/agent-sdk/bundled/agents}"
CORE_BUNDLE_SKILLS_DIR="${ADAPTIVE_AGENT_CORE_BUNDLE_SKILLS_DIR:-$ROOT_DIR/packages/agent-sdk/bundled/skills}"

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
ORIGINAL_BUNDLED_ASSETS=$(mktemp)
cp "$BUNDLED_ASSETS" "$ORIGINAL_BUNDLED_ASSETS"
restore_build_info() {
  cp "$ORIGINAL_BUILD_INFO" "$BUILD_INFO"
  cp "$ORIGINAL_BUNDLED_ASSETS" "$BUNDLED_ASSETS"
  rm -f "$ORIGINAL_BUILD_INFO"
  rm -f "$ORIGINAL_BUNDLED_ASSETS"
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

write_bundled_assets() {
  bun --eval '
    import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
    import { basename, join, relative, sep } from "node:path";

    const [targetPath, agentsDir, skillsDir] = process.argv.slice(1);
    const agents = {};
    const skills = {};
    const coreAgents = [];
    const coreSkills = [];

    function readJson(path) {
      try {
        return JSON.parse(readFileSync(path, "utf-8"));
      } catch (error) {
        throw new Error(`Unable to read bundled agent JSON ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    function readSkillName(skillPath) {
      const raw = readFileSync(skillPath, "utf-8");
      const trimmed = raw.trimStart();
      if (!trimmed.startsWith("---")) throw new Error(`Bundled skill ${skillPath} is missing YAML frontmatter.`);
      const endIndex = trimmed.indexOf("---", 3);
      if (endIndex === -1) throw new Error(`Bundled skill ${skillPath} is missing closing YAML frontmatter marker.`);
      for (const line of trimmed.slice(3, endIndex).split("\n")) {
        const value = line.trim();
        if (!value.startsWith("name:")) continue;
        let name = value.slice("name:".length).trim();
        const apostrophe = String.fromCharCode(39);
        if ((name.startsWith("\"") && name.endsWith("\"")) || (name.startsWith(apostrophe) && name.endsWith(apostrophe))) {
          name = name.slice(1, -1);
        }
        if (name) return name;
      }
      throw new Error(`Bundled skill ${skillPath} is missing required frontmatter field "name".`);
    }

    function readSkillFiles(root, dir = root, result = {}) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          readSkillFiles(root, path, result);
          continue;
        }
        if (!entry.isFile()) continue;
        const relativePath = relative(root, path).split(sep).join("/");
        result[relativePath] = readFileSync(path, "utf-8");
      }
      return result;
    }

    if (agentsDir && existsSync(agentsDir)) {
      for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const path = join(agentsDir, entry.name);
        const config = readJson(path);
        if (typeof config.id !== "string" || !config.id.trim()) throw new Error(`Bundled agent ${path} is missing string id.`);
        const { model: _model, ...configWithoutModel } = config;
        agents[config.id] = { id: config.id, fileName: basename(path), config: configWithoutModel };
        coreAgents.push(config.id);
      }
    }

    if (skillsDir && existsSync(skillsDir)) {
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(skillsDir, entry.name);
        const skillPath = join(dir, "SKILL.md");
        if (!existsSync(skillPath) || !statSync(skillPath).isFile()) continue;
        const name = readSkillName(skillPath);
        skills[name] = { name, files: readSkillFiles(dir) };
        coreSkills.push(name);
      }
    }

    const catalog = {
      defaultBundles: [],
      bundles: { core: { agents: coreAgents, skills: coreSkills } },
      agents,
      skills,
    };

    writeFileSync(targetPath, `import type { BundledInstallCatalog } from "./bundled-assets.js";\n\nexport const GENERATED_BUNDLED_INSTALL_CATALOG = ${JSON.stringify(catalog, null, 2)} satisfies BundledInstallCatalog;\n`);
    console.log(`Bundled core assets: agents=${coreAgents.length} skills=${coreSkills.length}`);
  ' "$BUNDLED_ASSETS" "$CORE_BUNDLE_AGENTS_DIR" "$CORE_BUNDLE_SKILLS_DIR"
}

compile_target() {
  target="$1"
  bun_target="$2"
  adaptive_agent_exe_name="$3"
  trace_session_exe_name="$4"
  asset_name="$5"

  work_dir="$OUT_DIR/work/$target"
  rm -rf "$work_dir"
  mkdir -p "$work_dir"
  write_build_info "$target"

  printf 'Building %s\n' "$target"
  bun build "$ADAPTIVE_AGENT_ENTRYPOINT" \
    --compile \
    --target="$bun_target" \
    --outfile="$work_dir/$adaptive_agent_exe_name"

  bun build "$TRACE_SESSION_ENTRYPOINT" \
    --compile \
    --target="$bun_target" \
    --outfile="$work_dir/$trace_session_exe_name"

  if [ "${asset_name##*.}" = "zip" ]; then
    if command -v zip >/dev/null 2>&1; then
      (cd "$work_dir" && zip -q "$OUT_DIR/$asset_name" "$adaptive_agent_exe_name" "$trace_session_exe_name")
    elif command -v ditto >/dev/null 2>&1; then
      (cd "$work_dir" && ditto -c -k --sequesterRsrc . "$OUT_DIR/$asset_name")
    else
      fail 'zip or ditto is required to package Windows assets'
    fi
  else
    tar -czf "$OUT_DIR/$asset_name" -C "$work_dir" "$adaptive_agent_exe_name" "$trace_session_exe_name"
  fi
}

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
write_bundled_assets

compile_target darwin-arm64 bun-darwin-arm64 adaptive-agent trace-session "adaptive-agent-$TAG-darwin-arm64.tar.gz"
compile_target darwin-x64 bun-darwin-x64 adaptive-agent trace-session "adaptive-agent-$TAG-darwin-x64.tar.gz"
compile_target linux-arm64 bun-linux-arm64 adaptive-agent trace-session "adaptive-agent-$TAG-linux-arm64.tar.gz"
compile_target linux-x64 bun-linux-x64 adaptive-agent trace-session "adaptive-agent-$TAG-linux-x64.tar.gz"
compile_target windows-x64 bun-windows-x64 adaptive-agent.exe trace-session.exe "adaptive-agent-$TAG-windows-x64.zip"

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
