#!/usr/bin/env bash
# Link (or copy) every skill in this repo into each installed agent's skills directory.
# Usage: bash install.sh          (junctions on Windows, symlinks elsewhere)
#        COPY=1 bash install.sh   (copy instead of link)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$REPO_DIR/skills"

# "agent base dir|skills dir" — targets whose base dir is missing are skipped
TARGETS=(
  "$HOME/.qoder|$HOME/.qoder/skills"
  "$HOME/.codex|$HOME/.codex/skills"
  "$HOME/.gemini|$HOME/.gemini/config/skills"
  "$HOME/.hermes|$HOME/.hermes/skills"
  "$HOME/AppData/Local/hermes|$HOME/AppData/Local/hermes/skills"
  "$HOME/.claude|$HOME/.claude/skills"
  "$HOME/.config/opencode|$HOME/.config/opencode/skills"
)

install_one() {
  local src="$1" dest="$2"
  if [ "${COPY:-0}" = "1" ]; then
    cp -r "$src" "$dest"
    return
  fi
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      cmd //c "mklink /J \"$(cygpath -w "$dest")\" \"$(cygpath -w "$src")\"" >/dev/null
      ;;
    *)
      ln -s "$src" "$dest"
      ;;
  esac
}

for entry in "${TARGETS[@]}"; do
  base="${entry%%|*}"
  skills_dir="${entry##*|}"
  if [ ! -d "$base" ]; then
    echo "skip (not installed): $base"
    continue
  fi
  mkdir -p "$skills_dir"
  for d in "$SKILLS_DIR"/*/; do
    name="$(basename "$d")"
    dest="$skills_dir/$name"
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      echo "exists, skip: $dest"
      continue
    fi
    install_one "${d%/}" "$dest"
    echo "installed: $dest"
  done
done