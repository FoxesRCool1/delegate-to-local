#!/usr/bin/env bash
# Deterministic tests for scripts/delegate-loop.ts against a scripted mock server.
# No local model needed. Run: test/run.sh
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
LOOP="$ROOT/scripts/delegate-loop.ts"
TSC="$ROOT/node_modules/.bin/tsc"
PORT=${MOCK_PORT:-18081}
URL="http://127.0.0.1:$PORT"
TMP=$(mktemp -d)
export DELEGATE_USAGE_LOG="$TMP/usage.jsonl"   # keep test runs out of ~/.claude/delegate-usage.jsonl
export DELEGATE_LOCK_DIR="$TMP/locks"          # and never wait on, or block, a real run
export DELEGATE_MODEL="qwen3.8-27b-delegate"   # the mock serves two ids; pick one the way a user would
export DELEGATE_CONFIG="$TMP/no-config.json"   # ignore the user's real config file
unset DELEGATE_URL DELEGATE_CTX
SERVER=""
PASS=0
FAIL=0
trap 'stop_mock; [ -n "${KEEP_TMP:-}" ] && echo "kept $TMP" || rm -rf "$TMP"' EXIT

# --- helpers -----------------------------------------------------------------

fixture() { # $1 dir. A TS project with a 36-line src/cart.ts to edit.
  mkdir -p "$1/src"
  ln -sfn "$ROOT/node_modules" "$1/node_modules"
  cat > "$1/tsconfig.json" <<'JSON'
{ "compilerOptions": { "target": "ESNext", "module": "ESNext", "moduleResolution": "bundler", "strict": true, "noEmit": true, "skipLibCheck": true, "types": ["bun"] }, "include": ["src/**/*.ts"] }
JSON
  cat > "$1/src/cart.ts" <<'TS'
/** A shopping cart line. */
export interface CartLine {
  sku: string;
  qty: number;
  unitCents: number;
}

/** Simple in-memory cart. */
export class Cart {
  private lines: CartLine[] = [];

  add(line: CartLine): void {
    const existing = this.lines.find((l) => l.sku === line.sku);
    if (existing) {
      existing.qty += line.qty;
      return;
    }
    this.lines.push({ ...line });
  }

  remove(sku: string): boolean {
    const before = this.lines.length;
    this.lines = this.lines.filter((l) => l.sku !== sku);
    return this.lines.length < before;
  }

  get count(): number {
    return this.lines.reduce((n, l) => n + l.qty, 0);
  }

  /** Total as a display string, e.g. "$10.50". */
  totalLabel(): string {
    const cents = this.lines.reduce((n, l) => n + l.qty * l.unitCents, 0);
    return "$" + (cents / 100).toFixed(2);
  }
}
TS
}

money_spec() { # $1 dir, $2 extra pass fields (JSON fragment, may be empty)
  cat > "$1/spec.json" <<JSON
{
  "root": "$1",
  "verify": [["$TSC", "--noEmit"]],
  "task": "Create src/money.ts exporting formatCents(cents: number): string. 1050 -> \"\$10.50\". Negative input puts the minus before the dollar sign: -1050 -> \"-\$10.50\".",
  "scope": ["src/money.ts"],
  "assert": ["export function formatCents(cents: number): string", { "text": "export default", "absent": true }]
  $2
}
JSON
}

GOOD_MONEY='<<<FILE src/money.ts>>>
export function formatCents(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  const body = "$" + Math.floor(abs / 100) + "." + String(abs % 100).padStart(2, "0");
  return cents < 0 ? "-" + body : body;
}
<<<END>>>'

NAIVE_MONEY='<<<FILE src/money.ts>>>
export function formatCents(cents: number): string {
  return "$" + (cents / 100).toFixed(2);
}
<<<END>>>'

BROKEN_MONEY='<<<FILE src/money.ts>>>
export function formatCents(cents: number): string {
  const x: number = "not a number";
  return "$" + x;
}
<<<END>>>'

start_mock() { # $1 replies dir, $2 requests log
  : > "$2"
  "$HERE/mock-llama.ts" "$1" "$PORT" "$2" >/dev/null 2>&1 &
  SERVER=$!
  for _ in $(seq 1 50); do
    curl -sf "$URL/v1/models" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  echo "mock server did not start on $PORT"
  exit 1
}

stop_mock() {
  if [ -n "$SERVER" ]; then kill "$SERVER" 2>/dev/null; wait "$SERVER" 2>/dev/null; SERVER=""; fi
}

ok()   { PASS=$((PASS + 1)); echo "    ok   $1"; }
fail() { FAIL=$((FAIL + 1)); echo "    FAIL $1"; }
expect_grep()     { if grep -qE -- "$2" "$3"; then ok "$1"; else fail "$1  (wanted /$2/ in $(basename "$3"))"; fi; }
expect_not_grep() { if grep -qE -- "$2" "$3"; then fail "$1  (found /$2/ in $(basename "$3"))"; else ok "$1"; fi; }
expect_eq()       { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1  (got '$2', wanted '$3')"; fi; }

run_loop() { # $1 dir, rest: extra flags. Report -> $1/report.txt, exit code -> $1/exit
  local d=$1; shift
  "$LOOP" "$d/spec.json" --url "$URL" --log "$d/run.log" "$@" > "$d/report.txt" 2> "$d/stderr.txt"
  echo $? > "$d/exit"
}

run_ask() { # $1 dir, rest: flags including --ask. Report -> $1/report.txt, exit code -> $1/exit
  local d=$1; shift
  "$LOOP" --root "$d" --url "$URL" --log "$d/run.log" "$@" > "$d/report.txt" 2> "$d/stderr.txt"
  echo $? > "$d/exit"
}

scenario() { echo; echo "== $1"; }

# --- scenarios ---------------------------------------------------------------

scenario "green first try, review OK"
D="$TMP/s1"; fixture "$D"; money_spec "$D" ""
mkdir -p "$D/replies"; printf '%s\n' "$GOOD_MONEY" > "$D/replies/1.txt"; printf 'OK\n' > "$D/replies/2.txt"
start_mock "$D/replies" "$D/requests.jsonl"; run_loop "$D"; stop_mock
expect_eq   "exit code 0" "$(cat "$D/exit")" 0
expect_grep "SUMMARY green, 1 attempt, 2/2 asserts, review OK" 'status=green files=src/money\.ts:5L\(new\) gate=tsc attempts=1 asserts=2/2 review=OK' "$D/report.txt"
expect_grep "STATUS green with log path" '^STATUS: green — 1/1 pass\(es\) verified in [0-9]+s\. Nothing was committed\. Log: ' "$D/report.txt"
expect_eq   "exactly 2 model calls (generate + review)" "$(wc -l < "$D/requests.jsonl")" 2
expect_grep "contract checks are in the first prompt" 'Contract checks \(run automatically on your output\)' "$D/requests.jsonl"
expect_grep "review prompt carries the numbered file" '   1\| export function formatCents' "$D/requests.jsonl"
expect_eq   "stderr is empty with --log" "$(wc -c < "$D/stderr.txt")" 0

scenario "review finds a defect, fix passes"
D="$TMP/s2"; fixture "$D"; money_spec "$D" ""
mkdir -p "$D/replies"
printf '%s\n' "$NAIVE_MONEY" > "$D/replies/1.txt"
printf '1. src/money.ts line 2: negative input yields "$-10.50"; the contract requires "-$10.50".\n' > "$D/replies/2.txt"
printf '%s\n' "$GOOD_MONEY" > "$D/replies/3.txt"
start_mock "$D/replies" "$D/requests.jsonl"; run_loop "$D"; stop_mock
expect_eq   "exit code 0" "$(cat "$D/exit")" 0
expect_grep "review=fixed, attempts=2" 'status=green .* attempts=2 asserts=2/2 review=fixed' "$D/report.txt"
expect_grep "REVIEW block says found and fixed" '^REVIEW: pass=src/money\.ts found and fixed:' "$D/report.txt"
expect_grep "fixed file is on disk" 'Math\.abs' "$D/src/money.ts"
expect_grep "fix request quotes the findings" 'A code review of your output found these defects' "$D/requests.jsonl"

scenario "review finds a defect, fix breaks the gate, verified version kept"
D="$TMP/s3"; fixture "$D"; money_spec "$D" ""
mkdir -p "$D/replies"
printf '%s\n' "$GOOD_MONEY" > "$D/replies/1.txt"
printf '1. src/money.ts line 3: bogus complaint.\n' > "$D/replies/2.txt"
printf '%s\n' "$BROKEN_MONEY" > "$D/replies/3.txt"
start_mock "$D/replies" "$D/requests.jsonl"; run_loop "$D"; stop_mock
expect_eq   "exit code 0 (still green)" "$(cat "$D/exit")" 0
expect_grep "review=kept-verified" 'status=green .* review=kept-verified' "$D/report.txt"
expect_grep "REVIEW block explains the rollback" '^REVIEW: pass=src/money\.ts found; fix failed the gate, so the verified version was kept:' "$D/report.txt"
expect_grep "verified file restored" 'Math\.abs' "$D/src/money.ts"
expect_not_grep "broken fix not on disk" 'not a number' "$D/src/money.ts"

scenario "--no-review skips the review call"
D="$TMP/s4"; fixture "$D"; money_spec "$D" ""
mkdir -p "$D/replies"; printf '%s\n' "$GOOD_MONEY" > "$D/replies/1.txt"
start_mock "$D/replies" "$D/requests.jsonl"; run_loop "$D" --no-review; stop_mock
expect_grep "review=off" 'review=off' "$D/report.txt"
expect_eq   "exactly 1 model call" "$(wc -l < "$D/requests.jsonl")" 1

scenario "truncated reply bumps the budget without spending a retry"
D="$TMP/s5"; fixture "$D"; money_spec "$D" ', "maxTokens": 500'
mkdir -p "$D/replies"
printf '<<<FILE src/money.ts>>>\nexport function formatCents(cents: number): string {\n' > "$D/replies/1.length.txt"
printf '%s\n' "$GOOD_MONEY" > "$D/replies/2.txt"; printf 'OK\n' > "$D/replies/3.txt"
start_mock "$D/replies" "$D/requests.jsonl"; run_loop "$D"; stop_mock
expect_grep "green with attempts=1" 'status=green .* attempts=1 asserts=2/2 review=OK' "$D/report.txt"
expect_grep "log shows the bump" 'raising budget to 1000 \(bump 1/4, not a retry\)' "$D/run.log"
expect_eq   "truncated reply not kept in the transcript (2nd request has 2 messages)" "$(sed -n 2p "$D/requests.jsonl" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["messages"]))')" 2

scenario "failed contract check is fed back, second attempt passes"
D="$TMP/s6"; fixture "$D"; money_spec "$D" ""
mkdir -p "$D/replies"
printf '<<<FILE src/money.ts>>>\nexport function formatMoney(cents: number): string {\n  return "$" + (cents / 100).toFixed(2);\n}\n<<<END>>>\n' > "$D/replies/1.txt"
printf '%s\n' "$GOOD_MONEY" > "$D/replies/2.txt"; printf 'OK\n' > "$D/replies/3.txt"
start_mock "$D/replies" "$D/requests.jsonl"; run_loop "$D"; stop_mock
expect_grep "green on attempt 2" 'status=green .* attempts=2 asserts=2/2 review=OK' "$D/report.txt"
expect_grep "retry prompt names the missing text" 'REQUIRED: src/money\.ts must contain this text verbatim and does not:' "$D/requests.jsonl"

scenario "edit pass: shrink guard rejects a gutted re-emit, survivors asserted"
D="$TMP/s7"; fixture "$D"
cat > "$D/spec.json" <<JSON
{
  "root": "$D",
  "verify": [["$TSC", "--noEmit"]],
  "task": "Edit src/cart.ts: import formatCents from ./money and use it in totalLabel(). Change nothing else.",
  "scope": ["src/cart.ts"],
  "assert": [
    "import { formatCents } from \"./money\"",
    { "text": "toFixed(2)", "absent": true },
    "export interface CartLine",
    "remove(sku: string): boolean",
    "get count(): number"
  ]
}
JSON
printf '%s\n' "$GOOD_MONEY" | sed -n '2,6p' > "$D/src/money.ts"
mkdir -p "$D/replies"
printf '<<<FILE src/cart.ts>>>\nimport { formatCents } from "./money";\nexport class Cart { totalLabel(): string { return formatCents(0); } }\n<<<END>>>\n' > "$D/replies/1.txt"
{ printf '<<<FILE src/cart.ts>>>\nimport { formatCents } from "./money";\n'; sed 's|return "\$" + (cents / 100).toFixed(2);|return formatCents(cents);|' "$D/src/cart.ts"; printf '<<<END>>>\n'; } > "$D/replies/2.txt"
printf 'OK\n' > "$D/replies/3.txt"
start_mock "$D/replies" "$D/requests.jsonl"; run_loop "$D"; stop_mock
expect_grep "green on attempt 2 with edit counts" 'status=green files=src/cart\.ts:37L\(\+2/-1\) gate=tsc attempts=2 asserts=5/5 review=OK' "$D/report.txt"
expect_grep "log shows the shrink rejection" 'rejected as truncated re-emit: src/cart\.ts: 36 lines -> 2 lines' "$D/run.log"
expect_grep "shrink feedback sent to the model" 'You dropped most of the file' "$D/requests.jsonl"
expect_grep "original members survived" 'remove\(sku: string\): boolean' "$D/src/cart.ts"

scenario "two passes, second uses the first's output as context, pre-flight skipped"
D="$TMP/s8"; fixture "$D"
cat > "$D/spec.json" <<JSON
{
  "root": "$D",
  "verify": [["$TSC", "--noEmit"]],
  "review": false,
  "passes": [
    { "name": "money", "task": "Create src/money.ts", "scope": ["src/money.ts"], "assert": ["export function formatCents"] },
    { "name": "cart", "task": "Use it", "scope": ["src/cart.ts"], "context": ["src/money.ts"], "assert": ["import { formatCents } from \"./money\""] }
  ]
}
JSON
mkdir -p "$D/replies"
printf '%s\n' "$GOOD_MONEY" > "$D/replies/1.txt"
{ printf '<<<FILE src/cart.ts>>>\nimport { formatCents } from "./money";\n'; sed 's|return "\$" + (cents / 100).toFixed(2);|return formatCents(cents);|' "$D/src/cart.ts"; printf '<<<END>>>\n'; } > "$D/replies/2.txt"
start_mock "$D/replies" "$D/requests.jsonl"; run_loop "$D"; stop_mock
expect_grep "pass 1 green" '^SUMMARY: pass=money status=green' "$D/report.txt"
expect_grep "pass 2 green" '^SUMMARY: pass=cart status=green files=src/cart\.ts:37L\(\+2/-1\)' "$D/report.txt"
expect_grep "STATUS 2/2" '^STATUS: green — 2/2 pass' "$D/report.txt"
expect_grep "second pass saw the first pass's file" 'Read-only context: src/money\.ts' "$D/requests.jsonl"
expect_grep "pre-flight skipped on pass 2" '\[cart\] gate pre-flight skipped' "$D/run.log"

scenario "retries exhausted -> failed, errors in the report"
D="$TMP/s9"; fixture "$D"; money_spec "$D" ""
mkdir -p "$D/replies"; for i in 1 2 3; do printf '%s\n' "$BROKEN_MONEY" > "$D/replies/$i.txt"; done
start_mock "$D/replies" "$D/requests.jsonl"; run_loop "$D" --max-retries 2; stop_mock
expect_eq   "exit code 2" "$(cat "$D/exit")" 2
expect_grep "SUMMARY failed, review skipped" 'status=failed .* attempts=3 .* review=skipped' "$D/report.txt"
expect_grep "STATUS failed with reason" '^STATUS: failed — retries exhausted \(3 attempts\)\. 0/1 pass' "$D/report.txt"
expect_grep "tsc errors follow" "not assignable to type 'number'" "$D/report.txt"

scenario "boundary path refused before any model call"
D="$TMP/s10"; fixture "$D"
cat > "$D/spec.json" <<JSON
{ "root": "$D", "verify": [["$TSC", "--noEmit"]], "task": "x", "scope": ["src/auth.ts"] }
JSON
mkdir -p "$D/replies"
start_mock "$D/replies" "$D/requests.jsonl"; run_loop "$D"; stop_mock
expect_eq   "exit code 2" "$(cat "$D/exit")" 2
expect_grep "note boundary violation" 'note="boundary violation"' "$D/report.txt"
expect_eq   "no model call was made" "$(wc -l < "$D/requests.jsonl")" 0

scenario "gate already failing -> refused"
D="$TMP/s11"; fixture "$D"; money_spec "$D" ""
printf 'const broken: number = "x";\n' > "$D/src/broken.ts"
mkdir -p "$D/replies"
start_mock "$D/replies" "$D/requests.jsonl"; run_loop "$D"; stop_mock
expect_grep "note names the pre-flight" 'note="gate already failing before any change"' "$D/report.txt"
expect_eq   "no model call was made" "$(wc -l < "$D/requests.jsonl")" 0

scenario "bad spec: old 'pattern' key is rejected with a clear message"
D="$TMP/s12"; fixture "$D"
cat > "$D/spec.json" <<JSON
{ "root": "$D", "verify": [["$TSC", "--noEmit"]], "task": "x", "scope": ["src/a.ts"], "assert": [{ "pattern": "x" }] }
JSON
run_loop "$D"
expect_eq   "exit code 4" "$(cat "$D/exit")" 4
expect_grep "STATUS aborted" '^STATUS: aborted — spec assert\[0\]: "pattern" is no longer accepted' "$D/report.txt"

scenario "unknown flag is rejected"
D="$TMP/s13"; fixture "$D"; money_spec "$D" ""
run_loop "$D" --think
expect_eq   "exit code 4" "$(cat "$D/exit")" 4
expect_grep "names the flag" 'unknown option --think' "$D/stderr.txt"

scenario "--diff prints a unified diff after the report"
D="$TMP/s14"; fixture "$D"; money_spec "$D" ""
mkdir -p "$D/replies"; printf '%s\n' "$GOOD_MONEY" > "$D/replies/1.txt"
start_mock "$D/replies" "$D/requests.jsonl"; run_loop "$D" --no-review --diff; stop_mock
expect_grep "report comes first" '^SUMMARY: .* status=green' "$D/report.txt"
expect_grep "diff header present" '^--- diff ---$' "$D/report.txt"
expect_grep "new file diff labels" '^\+\+\+ b/src/money\.ts$' "$D/report.txt"
expect_grep "diff body has the code" '^\+export function formatCents' "$D/report.txt"

scenario "ask: grep, read, answer"
D="$TMP/s15"; fixture "$D"; mkdir -p "$D/replies"
printf '[{"name":"grep","arguments":{"pattern":"totalLabel","path":"src"}}]\n' > "$D/replies/1.tool.json"
printf '[{"name":"read_file","arguments":{"path":"src/cart.ts"}},{"name":"list_dir","arguments":{"path":"."}}]\n' > "$D/replies/2.tool.json"
printf 'totalLabel() formats the cart total as dollars. See src/cart.ts:32-35.\n' > "$D/replies/3.txt"
start_mock "$D/replies" "$D/requests.jsonl"; run_ask "$D" --ask "Where is totalLabel defined and what does it return?"; stop_mock
expect_eq   "exit code 0" "$(cat "$D/exit")" 0
expect_grep "answer is printed first" '^totalLabel\(\) formats the cart total as dollars\. See src/cart\.ts:32-35\.$' "$D/report.txt"
expect_grep "STATUS answered with counts" '^STATUS: answered — 3 turn\(s\), 1 file\(s\) read of 15, 1 grep\(s\), 1 list\(s\), [0-9]+s\. Log: ' "$D/report.txt"
expect_not_grep "no WARNING" '^WARNING' "$D/report.txt"
expect_grep "first request offers 3 tools, small tool-turn budget, presence penalty" '^\{"model":"qwen3.8-27b-delegate","max_tokens":1000,"presence_penalty":1,"messages":\[.*\],"tools":3\}$' "$D/requests.jsonl"
expect_grep "grep result reached the model as a tool message" '"role":"tool","tool_call_id":"mock_1_0","content":"src/cart\.ts:32:  totalLabel\(\): string \{' "$D/requests.jsonl"
expect_grep "read_file result carries the file" '"role":"tool","tool_call_id":"mock_2_0","content":"/\*\* A shopping cart line\. \*/' "$D/requests.jsonl"
expect_grep "list_dir follows symlinks and puts dirs first" '"role":"tool","tool_call_id":"mock_2_1","content":"DIR   node_modules\\nDIR   replies\\nDIR   src\\nFILE  ' "$D/requests.jsonl"
expect_grep "usage log has an ask line" '"mode":"ask","root":"'"$D"'","status":"answered","turns":3,"reads":1,"greps":1' "$DELEGATE_USAGE_LOG"

scenario "ask: read budget exhausted -> WARNING, read_file withdrawn"
D="$TMP/s16"; fixture "$D"; mkdir -p "$D/replies"
printf '[{"name":"read_file","arguments":{"path":"src/cart.ts"}}]\n' > "$D/replies/1.tool.json"
printf '[{"name":"read_file","arguments":{"path":"tsconfig.json"}},{"name":"read_file","arguments":{"path":"src/cart.ts"}}]\n' > "$D/replies/2.tool.json"
printf 'Partial answer.\n' > "$D/replies/3.txt"
start_mock "$D/replies" "$D/requests.jsonl"; run_ask "$D" --ask "q" --read-budget 1; stop_mock
expect_grep "WARNING about the budget" '^WARNING: read budget exhausted at 1 file\(s\); .* Re-run with --read-budget 2' "$D/report.txt"
expect_grep "STATUS counts 1 read of 1" '^STATUS: answered — 3 turn\(s\), 1 file\(s\) read of 1,' "$D/report.txt"
expect_grep "second read got the budget error" '"content":"Error: read budget exhausted \(1 files\)\.' "$D/requests.jsonl"
expect_grep "re-read gets a short note, not the file again" '"tool_call_id":"mock_2_1","content":"Already done in an earlier turn: that read_file result is above' "$D/requests.jsonl"
expect_grep "third request offers only 2 tools" '"tools":2\}$' "$D/requests.jsonl"

scenario "ask: paths outside root and binaries are refused"
D="$TMP/s17"; fixture "$D"; mkdir -p "$D/replies"; printf 'PK\0\0binary' > "$D/blob.zip"
printf '[{"name":"read_file","arguments":{"path":"../../etc/passwd"}},{"name":"list_dir","arguments":{"path":"/etc"}},{"name":"grep","arguments":{"pattern":"root","path":"/"}},{"name":"read_file","arguments":{"path":"blob.zip"}}]\n' > "$D/replies/1.tool.json"
printf 'Nothing to see.\n' > "$D/replies/2.txt"
start_mock "$D/replies" "$D/requests.jsonl"; run_ask "$D" --ask "q"; stop_mock
expect_eq   "three escapes refused" "$(grep -o 'Error: path \\"[^"]*\\" is outside the project root' "$D/requests.jsonl" | wc -l)" 3
expect_grep "binary refused" 'Error: refusing to read \\"blob\.zip\\": extension \.zip is binary' "$D/requests.jsonl"
expect_grep "still answered" '^STATUS: answered — 2 turn\(s\), 0 file\(s\) read' "$D/report.txt"

scenario "ask: last turn withdraws tools and asks for the answer"
D="$TMP/s18"; fixture "$D"; mkdir -p "$D/replies"
printf '[{"name":"grep","arguments":{"pattern":"Cart"}}]\n' > "$D/replies/1.tool.json"
printf 'Cart is a class in src/cart.ts.\n' > "$D/replies/2.txt"
start_mock "$D/replies" "$D/requests.jsonl"; run_ask "$D" --ask "q" --max-turns 2; stop_mock
expect_grep "STATUS answered in 2 turns" '^STATUS: answered — 2 turn\(s\), 0 file\(s\) read of 15, 1 grep\(s\)' "$D/report.txt"
expect_grep "last-turn nudge sent with no tools" '"content":"This is your last turn\. Answer now with what you have\. Do not call tools\."\}\],"tools":0\}$' "$D/requests.jsonl"
expect_grep "WARNING says the answer was forced" '^WARNING: the model used all 2 turns and was told to answer with what it had, .* --max-turns 4\.$' "$D/report.txt"
expect_grep "usage log records the forced answer and the question" '"forced":"turns",.*"maxTurns":2,"question":"q"' "$DELEGATE_USAGE_LOG"
expect_grep "the system prompt states the turn limit" 'Budget: 15 file reads and 2 turns\.' "$D/requests.jsonl"

scenario "ask: spec-file form with --stdin attaches the input"
D="$TMP/s19"; fixture "$D"; mkdir -p "$D/replies"
cat > "$D/spec.json" <<JSON
{ "root": "$D", "ask": "Which error blocks the build?", "maxTurns": 3, "readBudget": 2 }
JSON
printf 'The TS2322 error in src/x.ts blocks it.\n' > "$D/replies/1.txt"
start_mock "$D/replies" "$D/requests.jsonl"
printf 'error TS2322: boom\nwarning: meh\n' | run_loop "$D" --stdin
stop_mock
expect_grep "answer printed" '^The TS2322 error in src/x\.ts blocks it\.$' "$D/report.txt"
expect_grep "STATUS uses the spec's read budget" '^STATUS: answered — 1 turn\(s\), 0 file\(s\) read of 2,' "$D/report.txt"
expect_grep "stdin reached the model inside the question" 'Which error blocks the build\?\\n\\nInput:\\n```\\nerror TS2322: boom\\nwarning: meh\\n```' "$D/requests.jsonl"

scenario "ask: no answer -> failed, exit 2"
D="$TMP/s20"; fixture "$D"; mkdir -p "$D/replies"; : > "$D/replies/1.txt"
start_mock "$D/replies" "$D/requests.jsonl"; run_ask "$D" --ask "q" --max-turns 1; stop_mock
expect_eq   "exit code 2" "$(cat "$D/exit")" 2
expect_grep "STATUS failed" '^STATUS: failed — no answer after 1 turn\(s\)\. 1 turn\(s\), 0 file\(s\) read' "$D/report.txt"

scenario "ask: spec file and --ask together are rejected"
D="$TMP/s21"; fixture "$D"; money_spec "$D" ""
run_loop "$D" --ask "q"
expect_eq   "exit code 4" "$(cat "$D/exit")" 4
expect_grep "clear message" 'give either a spec file or --ask, not both' "$D/stderr.txt"

scenario "ask: a runaway turn is thrown away and retried once; each distinct call runs once"
D="$TMP/s22"; fixture "$D"; mkdir -p "$D/replies"
python3 -c 'import json; print(json.dumps([{"name":"read_file","arguments":{"path":"src/cart.ts"}}]*12 + [{"name":"read_file","raw":"{\"path\": \"src/ca"}]))' > "$D/replies/1.tool.length.json"
printf '[{"name":"read_file","arguments":{"path":"src/cart.ts"}},{"name":"read_file","arguments":{"path":"./src/cart.ts"}},{"name":"grep","arguments":{"pattern":"Cart"}}]\n' > "$D/replies/2.tool.json"
printf '[{"name":"read_file","arguments":{"path":"src/cart.ts"}},{"name":"grep","arguments":{"pattern":"Cart","path":"."}}]\n' > "$D/replies/3.tool.json"
printf 'Cart is declared in src/cart.ts:9.\n' > "$D/replies/4.txt"
start_mock "$D/replies" "$D/requests.jsonl"; run_ask "$D" --ask "Where is Cart?"; stop_mock
expect_eq   "exit code 0" "$(cat "$D/exit")" 0
expect_grep "log says why the turn was thrown away" 'threw the turn away: it made 13 tool calls, over the limit of 10 per turn\. Retrying once\.' "$D/run.log"
expect_grep "the retry tells the model why" '"content":"Your last reply was thrown away because it made 13 tool calls, over the limit of 10 per turn\.' "$D/requests.jsonl"
expect_not_grep "the half-written call never reached the server" 'src/ca[^r]' "$D/requests.jsonl"
expect_eq   "the duplicate in one turn was dropped (2 of 3 calls kept)" "$(sed -n 3p "$D/requests.jsonl" | python3 -c 'import json,sys; m=json.load(sys.stdin)["messages"]; print(len([x for x in m if x.get("tool_calls")][0]["tool_calls"]))')" 2
expect_grep "a repeat from an earlier turn gets a note" '"content":"Already done in an earlier turn: that read_file result is above and has not changed\. Do not repeat this call\. If you have nothing new to look up, answer now in plain text\."' "$D/requests.jsonl"
expect_grep "a grep spelled with path . counts as the same grep" '"content":"Already done in an earlier turn: that grep result is above' "$D/requests.jsonl"
expect_eq   "the file is in the final prompt exactly once" "$(tail -1 "$D/requests.jsonl" | grep -o 'A shopping cart line' | wc -l)" 1
expect_grep "STATUS counts repeats and thrown-away turns" '^STATUS: answered — 3 turn\(s\), 1 file\(s\) read of 15, 1 grep\(s\), 0 list\(s\), 3 repeated call\(s\) skipped, 1 turn\(s\) thrown away, [0-9]+s\.' "$D/report.txt"
expect_not_grep "one bad turn is no WARNING" '^WARNING' "$D/report.txt"
expect_grep "usage log records both" '"discarded":1,"repeats":3' "$DELEGATE_USAGE_LOG"

scenario "ask: a second bad turn ends tool use and forces the answer"
D="$TMP/s23"; fixture "$D"; mkdir -p "$D/replies"
printf '[{"name":"read_file","raw":"{\\"path\\": \\"src"}]\n' > "$D/replies/1.tool.json"
python3 -c 'import json; print(json.dumps([{"name":"grep","arguments":{"pattern":"p%d" % i}} for i in range(11)]))' > "$D/replies/2.tool.json"
printf 'Cart is in src/cart.ts.\n' > "$D/replies/3.txt"
start_mock "$D/replies" "$D/requests.jsonl"; run_ask "$D" --ask "q"; stop_mock
expect_grep "first bad turn: malformed call" 'threw the turn away: it held a half-written or malformed tool call\. Retrying once\.' "$D/run.log"
expect_grep "second bad turn ends tool use" 'threw the retry away too: it made 11 tool calls, over the limit of 10 per turn\. Tool use has ended\.' "$D/run.log"
expect_grep "forced answer is asked with no tools" '"content":"Your tool calls kept failing, so tool use has ended\. Answer now with what you have\. Do not call tools\."\}\],"tools":0\}$' "$D/requests.jsonl"
expect_eq   "the answer turn gets the full budget" "$(tail -1 "$D/requests.jsonl" | python3 -c 'import json,sys; print(json.load(sys.stdin)["max_tokens"])')" 8000
expect_eq   "no grep ran" "$(grep -c '"role":"tool"' "$D/requests.jsonl")" 0
expect_grep "WARNING says tool use ended early" '^WARNING: the model.s tool calls broke twice in a row' "$D/report.txt"
expect_grep "STATUS" '^STATUS: answered — 2 turn\(s\), 0 file\(s\) read of 15, 0 grep\(s\), 0 list\(s\), 2 turn\(s\) thrown away, [0-9]+s\.' "$D/report.txt"

scenario "ask: an answer longer than the tool-turn budget is asked for again with the full budget"
D="$TMP/s24"; fixture "$D"; mkdir -p "$D/replies"
printf 'The answer begins and then' > "$D/replies/1.length.txt"
printf 'The full answer.\n' > "$D/replies/2.txt"
start_mock "$D/replies" "$D/requests.jsonl"; run_ask "$D" --ask "q"; stop_mock
expect_grep "full answer printed" '^The full answer\.$' "$D/report.txt"
expect_not_grep "no cut-off WARNING" '^WARNING' "$D/report.txt"
expect_eq   "second request has the full budget" "$(sed -n 2p "$D/requests.jsonl" | python3 -c 'import json,sys; print(json.load(sys.stdin)["max_tokens"])')" 8000
expect_grep "STATUS: one turn, nothing thrown away" '^STATUS: answered — 1 turn\(s\), 0 file\(s\) read of 15, 0 grep\(s\), 0 list\(s\), [0-9]+s\.' "$D/report.txt"

scenario "ask: a read that would overflow the context is refused and not counted"
D="$TMP/s25"; fixture "$D"; mkdir -p "$D/replies"
python3 -c 'print("// filler line for the context test\n" * 1000)' > "$D/src/big.ts"
printf '[{"name":"read_file","arguments":{"path":"src/big.ts"}}]\n' > "$D/replies/1.tool.json"
printf 'Too big to read.\n' > "$D/replies/2.txt"
start_mock "$D/replies" "$D/requests.jsonl"; run_ask "$D" --ask "q" --ctx 12000 --max-tokens 2000; stop_mock
expect_grep "the model is told how much room is left" 'Error: \\"src/big\.ts\\" is 3[0-9]{4} chars, but only about [0-9]+ chars of context are left\.' "$D/requests.jsonl"
expect_grep "the read was not counted" '^STATUS: answered — 2 turn\(s\), 0 file\(s\) read of 15,' "$D/report.txt"

scenario "ask: a prompt over the context ceiling is never sent"
D="$TMP/s26"; fixture "$D"; mkdir -p "$D/replies"
start_mock "$D/replies" "$D/requests.jsonl"; run_ask "$D" --ask "q" --ctx 1000 --max-tokens 900; stop_mock
expect_eq   "exit code 2" "$(cat "$D/exit")" 2
expect_grep "STATUS names the ceiling" '^STATUS: failed — prompt ~[0-9]+ tok \+ answer budget 900 tok exceeds the 1000 tok context ceiling\.' "$D/report.txt"
expect_eq   "no request was sent" "$(wc -l < "$D/requests.jsonl")" 0

scenario "write: retries that outgrow the context drop the oldest attempt"
D="$TMP/s27"; fixture "$D"; money_spec "$D" ', "maxTokens": 500'
mkdir -p "$D/replies"
printf '%s\n' "$BROKEN_MONEY" > "$D/replies/1.txt"; printf '%s\n' "$BROKEN_MONEY" > "$D/replies/2.txt"; printf '%s\n' "$GOOD_MONEY" > "$D/replies/3.txt"
start_mock "$D/replies" "$D/requests.jsonl"; run_loop "$D" --no-review --ctx 1050; stop_mock
expect_grep "green on attempt 3" 'status=green .* attempts=3 asserts=2/2 review=off' "$D/report.txt"
expect_grep "log says an attempt was dropped" 'dropped the 1 oldest attempt\(s\) from the transcript to fit the 1050 tok context' "$D/run.log"
expect_eq   "second request kept everything (4 messages)" "$(sed -n 2p "$D/requests.jsonl" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["messages"]))')" 4
expect_eq   "third request dropped attempt 1 (4 messages, not 6)" "$(sed -n 3p "$D/requests.jsonl" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["messages"]))')" 4

scenario "lock: a second run waits for the first and says why"
D="$TMP/s28"; fixture "$D"; mkdir -p "$D/replies"
printf 'First answer.\n' > "$D/replies/1.txt"; printf 'Second answer.\n' > "$D/replies/2.txt"
export MOCK_DELAY_MS=2500; start_mock "$D/replies" "$D/requests.jsonl"; unset MOCK_DELAY_MS
"$LOOP" --root "$D" --url "$URL" --log "$D/first.log" --ask "first" > "$D/first.txt" 2>&1 &
FIRST=$!
for _ in $(seq 1 50); do ls "$DELEGATE_LOCK_DIR"/*.lock >/dev/null 2>&1 && break; sleep 0.1; done
run_ask "$D" --ask "second"
wait "$FIRST"; stop_mock
expect_grep "first run answered" '^First answer\.$' "$D/first.txt"
expect_grep "second run logged who it waited for" '^waiting: another delegate-loop run \(pid [0-9]+, ask on .*/s28, started [^)]+\) is using the model\.' "$D/run.log"
expect_grep "second run answered after the first" '^Second answer\.$' "$D/report.txt"
expect_grep "second report has a NOTE" '^NOTE: waited [0-9]+s for another delegate-loop run \(pid [0-9]+, ask on ' "$D/report.txt"
expect_eq   "both runs released the lock" "$(find "$DELEGATE_LOCK_DIR" -type f | wc -l)" 0
expect_grep "usage log records the wait" '"waited":[0-9]+' "$DELEGATE_USAGE_LOG"

scenario "lock: a stale lock is cleared; a live one with --lock-wait 0 aborts"
D="$TMP/s29"; fixture "$D"; mkdir -p "$D/replies" "$DELEGATE_LOCK_DIR"
printf 'Answer.\n' > "$D/replies/1.txt"
LOCKF="$DELEGATE_LOCK_DIR/127.0.0.1_$PORT.lock"
sh -c 'exit 0' & DEAD=$!; wait "$DEAD"
printf '{"pid":%d,"mode":"ask","root":"/gone","started":"then"}' "$DEAD" > "$LOCKF"
touch -d '2 minutes ago' "$LOCKF"   # its heartbeat stopped, so it may be cleared
start_mock "$D/replies" "$D/requests.jsonl"; run_ask "$D" --ask "q"
expect_grep "stale lock removed" 'removing a stale run lock \(pid [0-9]+ is gone\)' "$D/run.log"
expect_grep "then the run answered" '^STATUS: answered' "$D/report.txt"
bash -c 'exec -a delegate-loop-holder sleep 30' & HOLDER=$!
sleep 0.2
printf '{"pid":%d,"mode":"write","root":"/busy","started":"now"}' "$HOLDER" > "$LOCKF"
D2="$TMP/s29b"; fixture "$D2"
run_ask "$D2" --ask "q" --lock-wait 0
stop_mock; kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null; rm -f "$LOCKF"
expect_eq   "exit code 3" "$(cat "$D2/exit")" 3
expect_grep "STATUS names the holder" '^STATUS: aborted — another delegate-loop run \(pid [0-9]+, write on /busy, started now\) still holds the model after 0s of waiting\.' "$D2/report.txt"
expect_eq   "no request was sent while blocked" "$(wc -l < "$D/requests.jsonl")" 1

scenario "patch: a missed SEARCH is fed back with the real lines; fuzzy indentation; review sees a diff"
D="$TMP/s30"; fixture "$D"
printf '%s\n' "$GOOD_MONEY" | sed -n '2,6p' > "$D/src/money.ts"
cat > "$D/spec.json" <<JSON
{
  "root": "$D",
  "verify": [["$TSC", "--noEmit"]],
  "patch": true,
  "task": "Edit src/cart.ts: import formatCents from ./money and use it in totalLabel(). Change nothing else.",
  "scope": ["src/cart.ts"],
  "assert": [
    "import { formatCents } from \"./money\"",
    { "text": "toFixed(2)", "absent": true },
    "export interface CartLine",
    "remove(sku: string): boolean",
    "get count(): number"
  ]
}
JSON
mkdir -p "$D/replies"
cat > "$D/replies/1.txt" <<'REPLY'
<<<EDIT src/cart.ts>>>
<<<SEARCH>>>
/** A shopping cart line. */
<<<REPLACE>>>
import { formatCents } from "./money";

/** A shopping cart line. */
<<<END>>>
<<<EDIT src/cart.ts>>>
<<<SEARCH>>>
    const cents = this.lines.reduce((n, l) => n + l.qty * l.unitCents, 0);
    return "$" + (cents / 100).toFixed(3);
<<<REPLACE>>>
    const cents = this.lines.reduce((n, l) => n + l.qty * l.unitCents, 0);
    return formatCents(cents);
<<<END>>>
REPLY
cat > "$D/replies/2.txt" <<'REPLY'
<<<EDIT src/cart.ts>>>
<<<SEARCH>>>
/** A shopping cart line. */
<<<REPLACE>>>
import { formatCents } from "./money";

/** A shopping cart line. */
<<<END>>>
<<<EDIT src/cart.ts>>>
<<<SEARCH>>>
  const cents = this.lines.reduce((n, l) => n + l.qty * l.unitCents, 0);
  return "$" + (cents / 100).toFixed(2);
<<<REPLACE>>>
  const cents = this.lines.reduce((n, l) => n + l.qty * l.unitCents, 0);
  return formatCents(cents);
<<<END>>>
REPLY
printf 'OK\n' > "$D/replies/3.txt"
start_mock "$D/replies" "$D/requests.jsonl"; run_loop "$D"; stop_mock
expect_eq   "exit code 0" "$(cat "$D/exit")" 0
expect_grep "green on attempt 2 with edit counts" 'status=green files=src/cart\.ts:38L\(\+3/-1\) gate=tsc attempts=2 asserts=5/5 review=OK' "$D/report.txt"
expect_grep "log: nothing written on the miss" '1 edit error\(s\); nothing was written' "$D/run.log"
expect_grep "the miss shows the real lines, numbered after the earlier block" 'EDIT 2 on src/cart\.ts: SEARCH was not found\. Its first line occurs, but the lines after it differ\. The current file there:\\n +34\| +totalLabel' "$D/requests.jsonl"
expect_grep "the patch prompt asks for EDIT blocks" 'change it with EDIT blocks' "$D/requests.jsonl"
expect_grep "indentation was repaired" '^    return formatCents\(cents\);$' "$D/src/cart.ts"
expect_grep "import landed on line 1" '^import \{ formatCents \} from "\./money";$' "$D/src/cart.ts"
expect_grep "review is shown a diff" 'unified diff of the change' "$D/requests.jsonl"
expect_not_grep "review is not shown the untouched middle" 'this\.lines\.filter' <(sed -n 3p "$D/requests.jsonl")

scenario "patch: a whole-file block and an ambiguous SEARCH are refused; an empty REPLACE deletes cleanly"
D="$TMP/s31"; fixture "$D"
cat > "$D/spec.json" <<JSON
{
  "root": "$D",
  "verify": [["$TSC", "--noEmit"]],
  "patch": true,
  "task": "Delete the count getter from src/cart.ts. Change nothing else.",
  "scope": ["src/cart.ts"],
  "assert": [{ "text": "get count(): number", "absent": true }, "remove(sku: string): boolean"]
}
JSON
mkdir -p "$D/replies"
{ printf '<<<FILE src/cart.ts>>>\n'; cat "$D/src/cart.ts"; printf '<<<END>>>\n'; } > "$D/replies/1.txt"
printf '<<<EDIT src/cart.ts>>>\n<<<SEARCH>>>\n  }\n<<<REPLACE>>>\n<<<END>>>\n' > "$D/replies/2.txt"
cat > "$D/replies/3.txt" <<'REPLY'
<<<EDIT src/cart.ts>>>
<<<SEARCH>>>
  get count(): number {
    return this.lines.reduce((n, l) => n + l.qty, 0);
  }

<<<REPLACE>>>
<<<END>>>
REPLY
start_mock "$D/replies" "$D/requests.jsonl"; run_loop "$D" --no-review; stop_mock
expect_grep "green on attempt 3, 4 lines removed" 'status=green files=src/cart\.ts:32L\(\+0/-4\) gate=tsc attempts=3 asserts=2/2' "$D/report.txt"
expect_grep "whole-file block refused" 'src/cart\.ts already exists, so change it with EDIT blocks\. Do not re-emit the whole file\.' "$D/requests.jsonl"
expect_grep "ambiguous SEARCH refused" 'EDIT 1 on src/cart\.ts: SEARCH matches 5 or more places \(lines [0-9, ]+\)\. Add neighbouring lines so it matches exactly one\.' "$D/requests.jsonl"
expect_eq   "no double blank line left behind" "$(python3 -c 'import sys; print("\n\n\n" in open(sys.argv[1]).read())' "$D/src/cart.ts")" False

scenario "lock: waiting runs get the model in arrival order"
D="$TMP/s32"; fixture "$D"; mkdir -p "$D/replies" "$DELEGATE_LOCK_DIR"
printf 'Answer one.\n' > "$D/replies/1.txt"; printf 'Answer two.\n' > "$D/replies/2.txt"
LOCKF="$DELEGATE_LOCK_DIR/127.0.0.1_$PORT.lock"
bash -c 'exec -a delegate-loop-holder sleep 30' & HOLDER=$!
sleep 0.2
printf '{"pid":%d,"mode":"write","root":"/busy","started":"now"}' "$HOLDER" > "$LOCKF"
start_mock "$D/replies" "$D/requests.jsonl"
"$LOOP" --root "$D" --url "$URL" --log "$D/a.log" --ask "a" > "$D/a.txt" 2>&1 & A=$!
sleep 1.5
"$LOOP" --root "$D" --url "$URL" --log "$D/b.log" --ask "b" > "$D/b.txt" 2>&1 & B=$!
sleep 1.0
# Freed between the first run's poll and the second's, so a plain race would let the second win.
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null; rm -f "$LOCKF"
wait "$A"; wait "$B"; stop_mock
expect_grep "the run that queued first went first" '^Answer one\.$' "$D/a.txt"
expect_grep "the later run went second" '^Answer two\.$' "$D/b.txt"
expect_grep "the later run said it was queued behind" '^waiting: 1 earlier run\(s\) are queued for the model ahead of this one\.$' "$D/b.log"
expect_eq   "queue and lock are empty afterwards" "$(find "$DELEGATE_LOCK_DIR" -type f | wc -l)" 0

scenario "ask: two turns in a row of only repeated calls end tool use"
D="$TMP/s33"; fixture "$D"; mkdir -p "$D/replies"
printf '[{"name":"grep","arguments":{"pattern":"Cart"}}]\n' > "$D/replies/1.tool.json"
printf '[{"name":"grep","arguments":{"pattern":"Cart"}}]\n' > "$D/replies/2.tool.json"
printf '[{"name":"grep","arguments":{"pattern":"Cart","path":"."}}]\n' > "$D/replies/3.tool.json"
printf 'Cart is declared in src/cart.ts:9.\n' > "$D/replies/4.txt"
start_mock "$D/replies" "$D/requests.jsonl"; run_ask "$D" --ask "Where is Cart?"; stop_mock
expect_eq   "exit code 0" "$(cat "$D/exit")" 0
expect_grep "log says tool use ended" '2 turns in a row only repeated earlier calls\. Tool use has ended\.' "$D/run.log"
expect_grep "the answer turn has no tools and says why" '"content":"Your last 2 turns only repeated calls you had already made, so there is nothing new to find\. Answer now with what you have\. Do not call tools\."\}\],"tools":0\}$' "$D/requests.jsonl"
expect_grep "STATUS says tool use ended on repeats" '^STATUS: answered — 4 turn\(s\), 0 file\(s\) read of 15, 1 grep\(s\), 0 list\(s\), 2 repeated call\(s\) skipped, tool use ended on repeats, [0-9]+s\.' "$D/report.txt"
expect_not_grep "a stall is not a WARNING" '^WARNING' "$D/report.txt"
expect_grep "usage log records the stall" '"repeats":2,"stalled":true' "$DELEGATE_USAGE_LOG"

scenario "ask: a repeat next to a new call is not a stall; the model is told the turns left at 60%"
D="$TMP/s34"; fixture "$D"; mkdir -p "$D/replies"
printf '[{"name":"grep","arguments":{"pattern":"Cart"}}]\n' > "$D/replies/1.tool.json"
printf '[{"name":"grep","arguments":{"pattern":"Cart"}},{"name":"grep","arguments":{"pattern":"sku"}}]\n' > "$D/replies/2.tool.json"
printf '[{"name":"grep","arguments":{"pattern":"Cart"}},{"name":"grep","arguments":{"pattern":"qty"}}]\n' > "$D/replies/3.tool.json"
printf '[{"name":"grep","arguments":{"pattern":"unitCents"}}]\n' > "$D/replies/4.tool.json"
printf 'Done.\n' > "$D/replies/5.txt"
start_mock "$D/replies" "$D/requests.jsonl"; run_ask "$D" --ask "q" --max-turns 6; stop_mock
expect_grep "answered on turn 5 with tools still on" '^STATUS: answered — 5 turn\(s\), 0 file\(s\) read of 15, 4 grep\(s\), 0 list\(s\), 2 repeated call\(s\) skipped, [0-9]+s\.' "$D/report.txt"
expect_not_grep "no stall" 'tool use ended on repeats' "$D/report.txt"
expect_not_grep "an answer the model chose to give is no WARNING" '^WARNING' "$D/report.txt"
expect_grep "turn 5 of 6 carries the nudge, tools still offered" '"content":"Turn 5 of 6\. 1 turn\(s\) are left after this one, and the last one allows no tools\. Make only the calls you still need, then answer\."\}\],"tools":3\}$' "$D/requests.jsonl"
expect_eq   "the nudge was sent once" "$(tail -1 "$D/requests.jsonl" | grep -o 'Turn [0-9]* of 6' | wc -l)" 1

scenario "bad spec: a misspelt key, an assert on a file outside scope, an unknown ask key"
D="$TMP/s35"; fixture "$D"
cat > "$D/spec.json" <<JSON
{ "root": "$D", "verify": [["$TSC", "--noEmit"]], "task": "t", "scope": ["src/money.ts"], "asserts": ["export function formatCents"] }
JSON
run_loop "$D"
expect_eq   "misspelt key: exit code 4" "$(cat "$D/exit")" 4
expect_grep "misspelt key: names the key and the fix" '^STATUS: aborted — spec: unknown key "asserts"\. Did you mean "assert"\? Allowed keys: ' "$D/report.txt"
cat > "$D/spec.json" <<JSON
{ "root": "$D", "verify": [["$TSC", "--noEmit"]], "passes": [ { "task": "t", "scope": ["src/money.ts", "src/index.ts"],
  "assert": [ { "text": "export function formatCents", "file": "./src/money.ts" }, { "text": "x", "file": "src/mony.ts" } ] } ] }
JSON
run_loop "$D"
expect_eq   "assert file outside scope: exit code 4" "$(cat "$D/exit")" 4
expect_grep "assert file outside scope: says which" '^STATUS: aborted — passes\[0\] assert\[1\]: "file" is "src/mony\.ts", which is not in this pass.s "scope" \(src/money\.ts, src/index\.ts\)' "$D/report.txt"
cat > "$D/spec.json" <<JSON
{ "root": "$D", "ask": "q", "read_budget": 40 }
JSON
run_loop "$D"
expect_eq   "unknown ask key: exit code 4" "$(cat "$D/exit")" 4
expect_grep "unknown ask key: names the fix" '^STATUS: aborted — ask spec: unknown key "read_budget"\. Did you mean "readBudget"\?' "$D/report.txt"

scenario "a context file that does not exist fails the pass before any model call"
D="$TMP/s36"; fixture "$D"; money_spec "$D" ', "context": ["src/cart.ts", "src/typos.ts"]'
mkdir -p "$D/replies"
start_mock "$D/replies" "$D/requests.jsonl"; run_loop "$D"; stop_mock
expect_eq   "exit code 2" "$(cat "$D/exit")" 2
expect_grep "SUMMARY carries the note" 'status=failed files=none gate=tsc attempts=0 .* note="context file not found"' "$D/report.txt"
expect_grep "the report names the file" '^  src/typos\.ts$' "$D/report.txt"
expect_eq   "no model call" "$(wc -l < "$D/requests.jsonl")" 0
expect_grep "usage log records why it failed" '"status":"failed".*"note":"context file not found"' "$DELEGATE_USAGE_LOG"

scenario "gate: a command that cannot start, and one that hangs, end in a report"
D="$TMP/s37"; fixture "$D"; money_spec "$D" ""
python3 - "$D/spec.json" '["/nonexistent/bin/pytest", "-q"]' <<'PY'
import json, sys
spec = json.load(open(sys.argv[1])); spec["verify"] = [json.loads(sys.argv[2])]; json.dump(spec, open(sys.argv[1], "w"))
PY
mkdir -p "$D/replies"
start_mock "$D/replies" "$D/requests.jsonl"; run_loop "$D"
expect_eq   "cannot start: exit code 2, not a crash" "$(cat "$D/exit")" 2
expect_grep "cannot start: STATUS line is there" '^STATUS: failed — gate already failing before any change\.' "$D/report.txt"
expect_grep "cannot start: the report says which program" 'cannot run "/nonexistent/bin/pytest": ' "$D/report.txt"
python3 - "$D/spec.json" '["/usr/bin/sleep", "20"]' <<'PY'
import json, sys
spec = json.load(open(sys.argv[1])); spec["verify"] = [json.loads(sys.argv[2])]; json.dump(spec, open(sys.argv[1], "w"))
PY
START=$(date +%s); run_loop "$D" --gate-timeout 1; stop_mock
expect_eq   "hang: exit code 2" "$(cat "$D/exit")" 2
expect_grep "hang: the report says it was killed" 'timed out after 1s and was killed\.' "$D/report.txt"
expect_eq   "hang: the run did not wait for the command" "$([ $(( $(date +%s) - START )) -lt 10 ] && echo fast || echo slow)" fast
expect_eq   "no model call in either run" "$(wc -l < "$D/requests.jsonl")" 0

scenario "ask: a grep with too many matches comes back as per-file counts"
D="$TMP/s38"; fixture "$D"; mkdir -p "$D/replies" "$D/src/wide"
for i in 1 2 3 4 5 6; do python3 -c 'print("\n".join(f"needle line {n}" for n in range(1, 51)))' > "$D/src/wide/n$i.ts"; done
printf '[{"name":"grep","arguments":{"pattern":"needle","path":"src/wide"}}]\n' > "$D/replies/1.tool.json"
printf '[{"name":"grep","arguments":{"pattern":"needle line 7$","path":"src/wide/n1.ts"}}]\n' > "$D/replies/2.tool.json"
printf 'Counted.\n' > "$D/replies/3.txt"
start_mock "$D/replies" "$D/requests.jsonl"; run_ask "$D" --ask "q"; stop_mock
expect_grep "the broad grep is summarised, not listed" '"role":"tool","tool_call_id":"mock_1_0","content":"(240\+|300) matches for /needle/ in 6 files: too many to list\. Matches per file, most first' "$D/requests.jsonl"
expect_grep "the summary names a file with its count" 'src/wide/n1\.ts: (40\+|50)' "$D/requests.jsonl"
expect_not_grep "no raw line from the broad grep reached the model" 'src/wide/n1\.ts:3:needle line 3' "$D/requests.jsonl"
expect_grep "a narrow grep still returns lines" '"content":"src/wide/n1\.ts:7:needle line 7' "$D/requests.jsonl"
expect_grep "STATUS counts both greps" '^STATUS: answered — 3 turn\(s\), 0 file\(s\) read of 15, 2 grep\(s\), 0 list\(s\),' "$D/report.txt"
expect_grep "usage log records answer size and context size" '"mode":"ask","root":"'"$D"'","status":"answered","turns":3,"reads":0,"greps":2,"elapsed":[0-9]+,"answerChars":8,"ctxTok":[0-9]+,' "$DELEGATE_USAGE_LOG"

scenario "settings: the context ceiling is read from the server, the model from the environment"
D="$TMP/s39"; fixture "$D"; mkdir -p "$D/replies"
printf 'Fine.\n' > "$D/replies/1.txt"
start_mock "$D/replies" "$D/requests.jsonl"; run_ask "$D" --ask "q"; stop_mock
expect_eq   "exit code 0" "$(cat "$D/exit")" 0
expect_grep "the log says the ceiling came from the server" '^context ceiling: 98304 tokens \(reported by the server\)$' "$D/run.log"
expect_grep "the model from DELEGATE_MODEL was sent" '"model":"qwen3.8-27b-delegate"' "$D/requests.jsonl"

scenario "settings: the config file supplies url, model and ctx when no flag or env does"
D="$TMP/s40"; fixture "$D"; mkdir -p "$D/replies"
printf '{ "url": "%s", "model": "qwen3.8-27b-chat", "ctx": 20000 }\n' "$URL" > "$D/config.json"
printf 'From config.\n' > "$D/replies/1.txt"
start_mock "$D/replies" "$D/requests.jsonl"
( unset DELEGATE_MODEL; DELEGATE_CONFIG="$D/config.json" "$LOOP" --ask "q" --root "$D" --log "$D/run.log" > "$D/report.txt" 2> "$D/stderr.txt"; echo $? > "$D/exit" )
stop_mock
expect_eq   "exit code 0" "$(cat "$D/exit")" 0
expect_grep "answered through the configured url" '^From config\.$' "$D/report.txt"
expect_grep "the configured model was sent" '"model":"qwen3.8-27b-chat"' "$D/requests.jsonl"
expect_not_grep "no ceiling probe when ctx is configured" 'context ceiling:' "$D/run.log"

scenario "settings: several served models and none configured -> abort that names them"
D="$TMP/s41"; fixture "$D"; mkdir -p "$D/replies"
start_mock "$D/replies" "$D/requests.jsonl"
( unset DELEGATE_MODEL; "$LOOP" --ask "q" --root "$D" --url "$URL" --log "$D/run.log" > "$D/report.txt" 2> "$D/stderr.txt"; echo $? > "$D/exit" )
stop_mock
expect_eq   "exit code 3" "$(cat "$D/exit")" 3
expect_grep "STATUS names both models and every way to pick one" '^STATUS: aborted — the server at .* serves 2 models and none is configured: qwen3.8-27b-delegate, qwen3.8-27b-chat\. Pick one: pass --model, set DELEGATE_MODEL, or put "model" in ' "$D/report.txt"
expect_eq   "no request was sent" "$(wc -l < "$D/requests.jsonl")" 0

scenario "settings: a model that is not served, and an unknown config key, are refused"
D="$TMP/s42"; fixture "$D"; mkdir -p "$D/replies"
start_mock "$D/replies" "$D/requests.jsonl"
run_ask "$D" --ask "q" --model nope
expect_eq   "not served: exit code 3" "$(cat "$D/exit")" 3
expect_grep "not served: STATUS lists what is" '^STATUS: aborted — model "nope" is not served at .*\. Available: qwen3.8-27b-delegate, qwen3.8-27b-chat$' "$D/report.txt"
printf '{ "modle": "x" }\n' > "$D/config.json"
( DELEGATE_CONFIG="$D/config.json" "$LOOP" --ask "q" --root "$D" --url "$URL" > "$D/report.txt" 2> "$D/stderr.txt"; echo $? > "$D/exit" )
stop_mock
expect_eq   "bad key: exit code 4" "$(cat "$D/exit")" 4
expect_grep "bad key: STATUS names the key and the file" '^STATUS: aborted — unknown key "modle" in .*config\.json; the keys are url, model, ctx$' "$D/report.txt"
expect_eq   "no request was sent" "$(wc -l < "$D/requests.jsonl")" 0

# --- summary -----------------------------------------------------------------

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
