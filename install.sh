#!/usr/bin/env bash
# Installs the delegate-to-local skill for the current user:
#   1. links this directory into the agent's skills folder (unless it already lives there)
#   2. installs the script's dependencies with bun
#   3. finds your local model server and writes ~/.config/delegate-to-local/config.json
#   4. prints a smoke test
# Options (or the same as env vars): --url URL (DELEGATE_URL), --model NAME (DELEGATE_MODEL),
#   --skill-dir DIR (DELEGATE_SKILL_DIR; default ~/.claude/skills/delegate-to-local)
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
SKILL_DIR="${DELEGATE_SKILL_DIR:-$HOME/.claude/skills/delegate-to-local}"
CONFIG="${DELEGATE_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/delegate-to-local/config.json}"
URL="${DELEGATE_URL:-}"
MODEL="${DELEGATE_MODEL:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL=$2; shift 2 ;;
    --model) MODEL=$2; shift 2 ;;
    --skill-dir) SKILL_DIR=$2; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 4 ;;
  esac
done

json_field() { # $1 file, $2 key -> value or empty
  bun -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=c[process.argv[2]];process.stdout.write(v==null?"":String(v))}catch{}' "$1" "$2"
}

# 1. bun
if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required and was not found. Install it: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

# 2. skill directory
if [ "$(cd "$SKILL_DIR" 2>/dev/null && pwd -P || true)" = "$HERE" ]; then
  echo "skill directory: $SKILL_DIR"
else
  if [ -e "$SKILL_DIR" ] && [ ! -L "$SKILL_DIR" ]; then
    echo "$SKILL_DIR already exists and is not a link. Move it away, or run this from a clone placed there."
    exit 1
  fi
  mkdir -p "$(dirname "$SKILL_DIR")"
  ln -sfn "$HERE" "$SKILL_DIR"
  echo "linked $SKILL_DIR -> $HERE"
fi

# 3. dependencies
(cd "$HERE" && bun install --silent)
echo "dependencies installed"
command -v rg >/dev/null 2>&1 || echo "note: ripgrep (rg) is not installed, so grep is used. rg is faster and respects .gitignore."

# 4. server and config
if [ -f "$CONFIG" ]; then
  URL=${URL:-$(json_field "$CONFIG" url)}
  MODEL=${MODEL:-$(json_field "$CONFIG" model)}
  CTX=$(json_field "$CONFIG" ctx)
else
  CTX=""
fi
URL=${URL:-http://127.0.0.1:8080}
URL=${URL%/}
models=$(curl -s -m 5 "$URL/v1/models" 2>/dev/null | bun -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write((JSON.parse(s).data||[]).map(m=>m.id).join("\n"))}catch{}})' || true)
if [ -z "$models" ]; then
  echo "no model server answered at $URL/v1/models."
  echo "Start it (llama-server, llama-swap, Ollama, LM Studio, vLLM), then run:"
  echo "  $HERE/install.sh --url http://127.0.0.1:PORT --model NAME"
  exit 0
fi
count=$(printf '%s\n' "$models" | wc -l)
if [ -z "$MODEL" ]; then
  if [ "$count" -eq 1 ]; then
    MODEL=$models
  else
    echo "the server at $URL serves $count models:"
    printf '  %s\n' $models
    echo "pick one and run:  $HERE/install.sh --url $URL --model NAME"
    exit 0
  fi
elif ! printf '%s\n' "$models" | grep -qxF -- "$MODEL"; then
  echo "model \"$MODEL\" is not served at $URL. Served:"
  printf '  %s\n' $models
  exit 1
fi
mkdir -p "$(dirname "$CONFIG")"
if [ -n "$CTX" ]; then
  printf '{ "url": "%s", "model": "%s", "ctx": %s }\n' "$URL" "$MODEL" "$CTX" > "$CONFIG"
else
  printf '{ "url": "%s", "model": "%s" }\n' "$URL" "$MODEL" > "$CONFIG"
fi
echo "wrote $CONFIG: url=$URL model=$MODEL${CTX:+ ctx=$CTX}"

# 5. smoke test
echo
echo "Done. Smoke test (loads the model; the first run can take a minute):"
echo "  $SKILL_DIR/scripts/delegate-loop.ts --ask \"What does install.sh do? Answer in two sentences.\" --root \"$HERE\" --read-budget 2"
echo "If the log says it is assuming a 32768-token context, put your model's real context size in $CONFIG as \"ctx\"."
