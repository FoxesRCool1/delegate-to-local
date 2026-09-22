# delegate-loop reference

Detail behind `SKILL.md` (decision, running, ask mode) and `write.md` (write mode).
Read the section you need; the happy path does not need this file.

Script: `scripts/delegate-loop.ts` in this skill's directory
(`~/.claude/skills/delegate-to-local/` for a user install). `--help` prints the spec
format, every flag and the settings order.

## Spec fields

| Field | Where | Meaning |
|---|---|---|
| `root` | top | Absolute project root. `scope` and `context` are relative to it and must resolve inside it. |
| `model` | top | Optional: the model id for this spec. Settings order: `--model` > spec > `DELEGATE_MODEL` > config file > the only model the server lists. Never a thinking or vision build. |
| `passes[]` | top | Ordered passes. A failing pass stops the batch. Top-level `verify`, `eslintScope`, `maxTokens`, `allowShrink`, `patch`, `review` are defaults each pass may override. |
| `name` | pass | Label in the report. Defaults to the first scope file. |
| `task` | pass | The contract. No length limit — the script never checks it. A 92-line contract produced a correct 567-line file. |
| `scope` | pass | The files this pass may create or edit. **More than one is fine**, and often better: group a file with its types and its barrel. Every file is emitted complete in the same reply. |
| `context` | pass | Read-only files shown to the model. Put the real signatures here so it matches actual names. |
| `assert` | pass | Contract checks. See below. |
| `verify` | pass/top | Custom gate, argv arrays run in `root`. Replaces tsc+eslint. |
| `eslintScope` | pass/top | Narrow eslint's reach. Defaults to `scope`. |
| `maxTokens` | pass/top | Generation budget. Default 8000 (~1000 lines). Doubles on truncation, up to 4 times / 32000 (~3500 lines). |
| `allowShrink` | pass/top | Skip the shrink guard for a pass meant to delete code. |
| `patch` | pass/top | `true`: the model sends SEARCH/REPLACE edit blocks instead of whole files. For edits to files too big to re-emit. See Patch mode. |
| `review` | pass/top | Self-review on (default) or off. |

**Spec checks, before any model call** (`STATUS: aborted`, exit 4). An unknown key
is refused, with the right name when it is a near miss (`asserts` → `assert`,
`read_budget` → `readBudget`): a misspelt `assert` would otherwise give a green pass
with no contract checks. With `passes`, only the default keys named above may sit at
the top level. An assert `file` must be one of the pass's `scope` paths, because the
model can write nothing else and a typo there would burn every retry on correct code.

To reference a file from a sibling project, copy a trimmed version into a
temporary `_ref/` inside `root` and delete it afterwards. The script refuses
paths that escape `root`.

## Settings

Three settings, first match wins: **flag > environment > config file > detection >
built-in**.

| Setting | Flag | Env | Config key | Detection | Built-in |
|---|---|---|---|---|---|
| server URL | `--url` | `DELEGATE_URL` | `url` | — | `http://127.0.0.1:8080` |
| model id | `--model` (or `model` in the spec) | `DELEGATE_MODEL` | `model` | the only id the server lists at `/v1/models` | — (several served and none chosen aborts, naming them) |
| context ceiling | `--ctx` | `DELEGATE_CTX` | `ctx` | `n_ctx` from `/props` (llama-server) or `/upstream/<model>/props` (llama-swap) | 32768, with a log line saying so |

The config file is `~/.config/delegate-to-local/config.json` (`DELEGATE_CONFIG` moves
it; `XDG_CONFIG_HOME` is honoured), a JSON object with any of `url`, `model`, `ctx`.
An unknown key is refused like a spec key. `install.sh` writes it. The server is
anything OpenAI-compatible that streams and does tool calls: llama-server,
llama-swap, Ollama, LM Studio, vLLM. Only llama-server reports its context size, so
**with any other server set `ctx`** to the model's real context length; a prompt
that overflows an unknown ceiling is cut by the server without a word, and the head
of the prompt, where the contract lives, is what goes. The probe runs after the run
lock is held, because behind llama-swap it loads the model.

## Sizing

- **~7.5 tokens per line** of TypeScript, measured across 7 generated files
  (6.2–8.3). Budget `maxTokens = lines x 9`.
- **Context ceiling 98,304 tokens**, estimated at `characters / 3.5`. The
  pre-flight refuses when `prompt + maxTokens` exceeds it, rather than letting the
  server reject mid-run.
- **The 3.5 ratio only holds for source.** Measured against the loaded model's own
  tokenizer: TypeScript 3.54, Markdown 4.30, JSON 2.50, `tsconfig.json` 2.62,
  `bun.lock` 1.88, minified JSON 1.53, base64 1.33. Dense data in `context` can
  pass the pre-flight and still overflow the server, which drops the head of the
  prompt — where the system prompt and your contract live. Keep lockfiles,
  minified assets and large JSON fixtures out of `context`.
- **Prefill ~1 s per 1,900 characters** (188,466 chars measured at ~100 s). Paid
  before the first output token; it is the biggest wall-clock lever.
- **Decode 46–61 tok/s** on shallow prompts. A 567-line file is ~78 s of generation.
- **The context check runs before every model call.** Each retry appends the
  model's reply plus up to 12,000 chars of gate errors. When `prompt + maxTokens`
  would pass `--ctx`, the oldest (reply, feedback) pairs are dropped first — every
  reply re-sends the complete change, so the newest pair is enough. A budget bump
  is capped at the room that is left. Only a first prompt that cannot fit stops
  the pass (`prompt exceeds context ceiling`).
- **Self-review does not re-send `context`** — only the generated file, or in patch
  mode a unified diff with 8 lines of context. A pass with a 54,600-token context
  reviewed in 6 s. Leaving review on is close to free.

## Patch mode

`"patch": true` on a pass (or top level). For an edit to a file too big to emit
whole: the default budget re-emits ~1000 lines, the ceiling ~3500, and a 150 KB
HTML file is ~43,000 tokens. The model answers with one block per change:

```
<<<EDIT web/ui.html>>>
<<<SEARCH>>>
function formatRemaining(minutes) {
    const m = Number(minutes || 0);
<<<REPLACE>>>
function formatRemaining(minutes) {
    const m = Number(minutes || 0);
    if (m >= 1440) return Math.floor(m / 1440) + 'd';
<<<END>>>
```

- **Applied to the original.** Every attempt's blocks are applied to the file as it
  was when the pass began, in order (a later block sees the earlier blocks'
  result). So every reply must carry the full set of edits, and the retry prompt
  says so. A failed attempt never leaves half an edit behind.
- **All or nothing.** If any block fails, nothing is written and every failure is
  fed back like a compiler error.
- **Matching.** Exact text first. Then line by line ignoring trailing whitespace.
  Then ignoring indentation, in which case REPLACE is shifted to the file's
  indentation. It must match exactly one place: several matches name the lines and
  ask for a neighbouring line; no match shows the real numbered lines where the
  SEARCH's first line occurs, or says no line matches it.
- **Deleting.** An empty REPLACE deletes the lines, including their line break.
- **New files** in a patch pass still come back as `<<<FILE path>>>` blocks. A FILE
  block for a file that already exists is refused ("change it with EDIT blocks").
- **Same guards.** Scope, boundary, shrink guard, gate, `assert`, review (on the
  diff), rollback of a review fix that fails the gate.
- **Contract.** Say where each change goes by naming its neighbour ("directly after
  the closing brace of function formatElapsed"). Assert the new text and the
  neighbours that must survive, same as any edit.

## `assert` forms

```json
"assert": [
  "export function clamp(n: number, lo: number, hi: number): number",
  { "text": "toFixed(2)", "absent": true },
  { "text": "export const VERSION", "file": "src/index.ts" },
  { "regex": "^import \\{ [A-Za-z, ]+ \\} from \"\\./money\"$" }
]
```

- A plain string, or `{"text": ...}`, is literal text. It is compared with all
  whitespace removed and trailing commas before `) ] }` dropped, so a signature
  the model wrapped onto two lines still matches while a wrong name or type still
  fails. No escaping needed.
- `absent: true` inverts the check.
- `file` pins the check to one path, which must be in `scope` (the spec is refused
  otherwise). Without `file`, any scope file may satisfy the check —
  so **when `scope` lists more than one file, pin every positive check with
  `file`**, or a pass that puts everything in one file still passes.
- `{"regex": ...}` is a JavaScript regex with the `m` flag, tried strictly first
  and then with the same whitespace tolerance. In JSON, `\` is `\\`.

The checks are listed in the model's prompt up front, and a failed check is fed
back exactly like a compiler error. Measured: given a full signature the model
matches it first try; given prose like `@throws RangeError when lo > hi` it writes
``@throws {RangeError} when `lo > hi` `` and the check never matches. Anchor only
on text you dictated character for character.

## Gates

**TypeScript (default).** Needs `tsconfig.json` and an eslint config in `root`.
Runs `bunx tsc --noEmit`, then `bunx eslint` on the scope files that exist.

**Everything else** sets `verify`. Rules: absolute tool paths; only check files
that already exist (a gate that fails because a not-yet-written file is missing
burns every retry). Pattern for a file that may not exist yet:

```json
"verify": [
  ["/usr/lib/qt6/bin/qmllint", "-I", "/usr/share/omarchy/shell", "App.qml"],
  ["/usr/bin/python3", "-c", "import pathlib,py_compile; p='bin/helper.py'; py_compile.compile(p, doraise=True) if pathlib.Path(p).exists() else None"],
  ["/usr/bin/node", "--check", "Model.js"]
]
```

**A failed attempt is named in the log.** The log line `attempt N failed verification:` is followed by the failing command and the first 1,200 chars of its output, so a gate error can be told from a contract miss without reading the model's transcript. The report carries the last attempt's errors under STATUS.

**A gate command always ends in a result.** One that cannot start (a wrong path in
`verify`) comes back as `cannot run "<tool>": ENOENT ...`, and the pre-flight then
stops the pass in 0 s. One that runs past `--gate-timeout` (default 300 s per
command; `0` = no limit) is killed and counts as failed with `timed out after Ns`:
at the pre-flight that means the gate never ends on its own (watch mode, a prompt);
on a retry it usually means an endless loop in the generated code, and the message is
fed back to the model like any other error. Gate commands get no stdin.

Know what the gate proves. `qmllint`, `py_compile`, `node --check` are SYNTAX
checks. Wiring and behaviour are what `assert`, the self-review, and your smoke
test are for. A hand-written unit-test suite is the strongest gate available and
is usually less work than writing the implementation: measured, a 32-test suite
drove a 366-line module to green, and a 75-test suite drove a 567-line one, with
no generated code read by the caller.

**Pre-flight.** Before any network call the gate runs on the UNCHANGED tree. A
gate that already fails cannot tell the model's mistakes from the project's.
Measured: a project whose eslint config could not parse TypeScript burned 4
attempts and 58 s producing correct code; the pre-flight catches that in 0 s. In a
batch the pre-flight is skipped for a pass whose predecessor left the tree green
under the same gate.

`--allow-dirty-gate` is for one shape only: the gate already refers to the file the
pass has not written yet, so it cannot pass until that file lands. That covers a new
module the project already imports (tsc fails), and a new module its tests already
import (the `verify` gate fails). It is NOT a way past a gate that is broken for any
other reason. Measured: a `verify` gate of `unittest` over a test that imports the
scope file aborted at `gate already failing before any change` on the first run,
and went green with the flag.

## Guards inside the loop

- **Context files must exist.** Checked at the start of each pass (not at load, since
  a later pass may list an earlier pass's output). A missing one fails the pass with
  `note="context file not found"` before the gate or the model runs. It used to be
  skipped with a line in the log, and the model then guessed the names it was meant
  to copy.
- **Shrink guard.** An edit to a file of 20+ lines that comes back under 50% of
  its line count is rejected and fed back as an error. The file on disk is not
  touched. `allowShrink: true` for a pass that is meant to remove code.
- **Budget bumps.** `finish_reason: length` doubles `maxTokens` and retries, up to
  4 bumps and 32,000 tokens. Bumps do not consume error-correction retries. A
  truncated reply is dropped from the transcript, not kept.
- **Out-of-scope paths** in the response are ignored and the model is told so.
- **Boundary paths** (auth, migrations, RLS, security definer, entitlements,
  `.server.*`) are refused on the declared scope/context and on every path the
  model returns. Tokenised on the path relative to `root`, so `authMiddleware.ts`
  and `user-auth/` match and `author.ts` does not.
- **Fail-fast batch.** The first non-green pass logs `FAILED — stopping the batch`
  and the remaining passes never run. Files already written by green passes stay
  on disk, as does the last failing generation of the dead pass.
- **Run lock.** One run per server URL at a time, via a lock file in
  `~/.cache/delegate-to-local/` (`DELEGATE_LOCK_DIR` overrides it; the tests use that).
  A second run polls every 2 s, logs `waiting: another delegate-loop run (pid, mode
  on root, started)`, and prints `NOTE: waited Ns ...` in its report. After
  `--lock-wait` seconds (default 1800; `0` = do not wait) it aborts with exit 3. The
  holder touches the lock file every 15 s. A lock is removed as stale only when it
  is over 60 s old AND its pid is gone (or now belongs to a process that is not
  delegate-loop), so a holder in a sandbox with its own pids is still respected. The
  lock is freed on exit, including SIGINT/SIGTERM/SIGHUP; after a SIGKILL the next
  run clears it within about a minute.
- **Self-review.** After green, a fresh conversation asks the model to judge the
  files against the contract and reply `OK` or a list of at most 5 defects.
  Findings get one fix attempt through the same gate and checks. If the fix is not
  green, the verified version is restored (`review=kept-verified`) and the findings
  are printed in a `REVIEW:` block for you to judge. Reasoning is off in this build
  and the review is capped at 1500 tokens, so on hard logic the prose rambles and
  can contradict itself — read a REVIEW block for *where* it is uneasy, which
  reliably marks an ambiguity in your contract, not for what it concludes.

## Model and sizing

Reference setup, where every number in these docs was measured: **Qwen3.8-27B,
Unsloth UD-Q4_K_XL (17.5 GB on disk)**, served by llama.cpp through llama-swap,
fully on a 24 GB GPU, nothing offloaded to CPU. Vision off (`--no-mmproj`) and
reasoning off (`-rea off`): there is no thinking phase. MTP speculative decoding is
on (`--spec-type draft-mtp --spec-draft-n-max 3`). The config is
`examples/llama-swap.config.yaml`. Another model or GPU changes the speeds and the
tokens-per-line ratio below; the loop, the gates and the guards do not change.

- **Context ceiling 98,304 tokens** (`-c 98304`).
- **Prefill ~1 s per 1,900 chars** of source (~550 tok/s at 55k depth, falling to
  ~375 tok/s near 100k).
- **Decode 46–61 tok/s** shallow, ~41 tok/s near a 100k prompt.
- **Swap-in ~4 s** when the chat build was loaded or after the 900 s idle unload.
  One `passes` batch pays it once.
- **Recall is good at depth:** 11/11 exact constants pulled from 12 context files
  totalling 54,600 tokens; 5/5 needles in a 99,657-token haystack.
- **VRAM about 23.4 of 24.0 GiB** while loaded. That is expected, not a fault. (The
  17.5 GB weight figure is decimal bytes; the VRAM figures are GiB.)

Measured 2026-09-15 against this build, all green, no generated code read by the
caller:

| job | result | attempts | time |
|---|---|---|---|
| 366-line tokenizer + Pratt parser + evaluator, 32-test gate | green; 19/20 correct on edge cases the gate never tested | 2 | 146 s |
| 567-line single file, 7 sections, 92-line contract, 75-test gate | green, 12/12 asserts | 2 | 192 s |
| 3 files in ONE pass (types + impl + barrel), 6-test gate | green, 5/5 asserts | 1 | 10 s |
| 6-pass batch, 252 lines over 6 modules, per-pass filtered gates | 6/6 green | 1 each | 45 s total |
| 12 context files (188,466 chars / ~54,600 tok), 11 exact constants to recall | green, 11/11 exact | 1 | 111 s |
| 41-line module, 6 unit tests as the gate | green | 1 | 11 s |
| 3-pass batch, one shared whole-suite gate | FAILED — pass 1 can never go green | 6 | 36 s |
| ask: inventory 22 Flask blueprints in a 3,650-file repo | 22/22 exact, incl. 3 multi-line calls and 6 misleading prefixes | 3 turns, 3 reads | 22 s |
| ask: read a 70,236-char file whole (`--max-read-chars 80000`) and quote a mechanism from its middle | correct, exact quote, citation within 1 line | 4 turns, 1 read | 43 s |
| ask: count 94 route decorators per HTTP method in the same repo | **partly wrong** — POST/PUT/DELETE/PATCH exact, GET 38 against a true 50, TOTAL 82 against 94 | 3 turns, 0 reads | 6 s |

Measured 2026-09-16:

| job | result | attempts | time |
|---|---|---|---|
| patch mode: 3 edits (new line in a function, new function after another, extended replace chain) to a 2,756-line / 153 KB `ui.html` (~43,900 tok prompt), gate = `node --check` on the inline scripts | green, 7/7 asserts, review OK, diff exactly `+9/-1`, ~309 tokens emitted | 1 | 86 s (80 s of it prefill) |
| ask, presence penalty 0: the "printer edit lifecycle" question that looped 353x before the guards | answered, 82 citations all in range, 0 turns thrown away | 12 turns, 5 reads | 406 s |
| ask, presence penalty 1.0: same question | answered, 42 citations all in range (1 of 6 spot-checked function lines wrong), 0 thrown away | 10 turns, 5 reads | 324 s |
| ask, presence penalty 0: the "Bambu camera path" question that looped 313x before | answered, 91 citations in range, 0 thrown away; hit 90% context and was told to answer | 16 turns, 10 reads | 706 s |
| ask, presence penalty 1.0: same question | answered, 76 citations in range, 0 thrown away | 20 turns, 9 reads | 836 s |

Measured 2026-09-22, after the server context went from 128k to 96k and the
grep summary landed (the two `notifications` rows are the same question before and
after it):

| job | result | attempts / turns | time |
|---|---|---|---|
| write: 117-line RFC 4180 CSV parser + stringifier, 31-test `bun test` gate + eslint, `--allow-dirty-gate` | green first try; review flagged a regex in `stringify` under a "no regex for parsing" rule, fix green | 1 (+1 review fix) | 30 s |
| write, pass 2 of the same spec: add `parseCSVObjects` to that file, gate tsc + eslint + 38 tests | green; attempt 1 failed a test, attempt 2 green, review OK, `+25/-0` | 2 | 37 s |
| ask: 4-part "how is an order created" on foxtrack (1,700 files), with a stop clause | all 4 parts right; 7 citations, 5 exact, 2 function-start lines off by a few | 9 turns, 3 reads, 7 greps | 97 s |
| ask: "How do notifications work in this app?" — before the grep summary | answered, 6,201 chars; first grep returned 42,318 chars, context ~12,600 tok by turn 2 | 5 turns, 4 reads, 2 greps | 96 s |
| ask: the same question after the grep summary and the "lead with the answer" rule | answered, 4,997 chars; first grep returned 3,438 chars, context ~1,560 tok by turn 2, 24,195 tok at the end | 7 turns, 6 reads, 5 greps | 82 s |
| ask: inventory every `HandleFunc`/`Handle` route in FoxTrack-Bridge (Go), told to grep not read | 27/27 routes, every path:line exact | 2 turns, 0 reads, 2 greps | 17 s |

**Read the presence-penalty rows as "no harm seen", not as proof it prevents
loops.** Neither setting looped in these 4 runs (the new system prompt line "never
repeat a call" and the guards changed the transcripts), so the A/B could not show
the penalty stopping one. It kept 1.0 as the default because Qwen recommends it and
nothing got worse. The loop guards, not the penalty, are what make a loop cheap.
The final answer turn at ~105,000 tokens of context took 415–532 s in both
settings; big multi-part asks spend most of their time there.

Read the batch rows together: extra passes cost seconds because the model stays
loaded, but only if each pass is gated on its own work.

All delegated output above also passed a strict `tsc --noEmit` it was never gated
on — 618 lines across 7 files, zero type errors.

## Failure notes (`note=` on a SUMMARY line)

| note | Fix |
|---|---|
| `gate already failing before any change`, and `scope` is a NEW file the gate already refers to | Re-run with `--allow-dirty-gate`. Expected, not a fault. |
| `gate already failing before any change`, any other case | Fix the project's gate. Not the spec. |
| `gate already failing before any change`, errors say `cannot run "<tool>"` | Wrong tool path in `verify`. |
| `gate already failing before any change`, errors say `timed out after Ns` | The gate does not end on its own. Use the one-shot form (`vitest run`), or raise `--gate-timeout` for a gate that is slow but correct. |
| `context file not found` | A `context` path is wrong; the report lists it. |
| `prompt exceeds context ceiling` | Trim `context`, or lower `maxTokens`. Check for dense data — see Sizing. |
| `still truncated at N tokens after 4 budget bump(s)` | The budget already reached 32,000 (or the room left in the context), so the file is over ~3500 lines. For an edit to an existing file, use `"patch": true`. For a new file, split across passes that write DIFFERENT files; re-splitting the same file changes nothing, because each pass re-emits it complete. |
| `boundary violation` / `model returned a hard-boundary path` | Off limits. Hand it back to the user. |
| `model server request failed` | The server dropped or refused the request; the note carries its reply. Check the server's log, and `ctx` against the model's real context size. |
| `STATUS: aborted — another delegate-loop run (...) still holds the model after Ns` | Exit 3. Another run is using the server; it is named. Wait for it, or pass a larger `--lock-wait`. |
| (none, `retries exhausted`) | Read the errors under STATUS. An assertion on text the model cannot emit verbatim, an ambiguity in the contract, or a gate that timed out on an endless loop in the generated code. |
| `STATUS: aborted — internal error: ...` | Exit 1. A bug in the script; the message is the thrown error. |

Exit codes: 0 green/answered, 1 internal error, 2 failed, 3 server or lock, 4 bad
spec or setup.

## Ask mode

Spec: `{ "root", "ask", "readBudget"?, "maxTurns"?, "maxReadChars"?, "maxFileBytes"?, "maxTokens"?, "toolTurnTokens"?, "presencePenalty"?, "model"? }`
or `--ask "question"` with `--root`, `--read-budget`, `--max-turns`,
`--max-read-chars`, `--max-file-bytes`, `--max-tokens`, `--tool-turn-tokens`,
`--presence-penalty`, `--stdin`.

Tools the model gets, all sandboxed to `root` (a path that escapes it returns an
error to the model, never to the filesystem):

| Tool | Cost | Limits |
|---|---|---|
| `read_file(path)` | 1 read | Refuses binaries (extension list plus a null-byte sniff) and files over `maxFileBytes` (default 500,000). Over `maxReadChars` (default 40,000) it is cut to head 60% + tail 40%, and the marker names the line range it dropped. Refused, and not counted, when the result would not fit the context that is left. A repeat read returns a short note, not the file again. |
| `list_dir(path)` | free | Directories first (symlinks followed), then files, 300 entries max. |
| `grep(pattern, path?, glob?)` | free | ripgrep when installed (respects .gitignore, skips hidden and binary), else GNU grep with a skip list. Every line carries its file name, also for a single-file grep. Up to 200 matches come back as `path:line:text` (200 chars per line; with ripgrep 40 per file, and the reply says how many files hit that cap). **Over 200 matches the reply is only a count per file** (most first, 80 files max) plus a note to grep one path or a tighter pattern. Measured 2026-09-22: the same broad first grep (`notification` over a 1,700-file app) went from 42,318 chars to 3,438, and the context at turn 2 from ~12,600 tokens to ~1,560. |

A list or grep result that would not fit the context that is left is cut, and says
so.

The loop: system prompt (the read budget AND the turn limit, look before you answer,
grep first, at most 10 calls per turn, never repeat a call, answer when there is
nothing new to look up, cite `path:line`, stop gathering at ~60% of the reads or the
turns), then up to `maxTurns` model turns. At 60% of the turns (turn 13 of 20; not
for runs under 6 turns) one user message tells the model how many turns are left. When the read budget is spent, `read_file` is
withdrawn from the tool list and the model is told. On the last turn, or when the
transcript nears 90% of the context ceiling, tools are withdrawn and the model is
told to answer with what it has. Both of those print a `WARNING:` (`used all N
turns`, `the context filled up`): the model did not choose to answer, so the answer
may be partial. Temperature 0.1, presence penalty 1.0. Exit 0 on an answer, 2 on none.

**Sizing a question.** Measured 2026-09-16 on FoxTrack-Bridge, 6-part questions
that read 5–10 files each:

| question | context at the end | time |
|---|---|---|
| one inventory (22 blueprints, 3 reads) | small | 22 s |
| 6 parts, 5 reads | ~85k tok | 324–406 s |
| 6 parts, 9–10 reads, one a 150 KB `ui.html` | ~105k tok | 706–836 s, of which 415–532 s was the final answer alone |

Those two big rows ran with a 128k server context. The ceiling is 98,304 now, so a
transcript like the last one is told to answer at ~88k tokens (90%) instead of
running on, and the report carries `WARNING: the context filled up`. Split such a
question; do not raise `--ctx`.

Launch asks one at a time: three at once cost one of them 326 s of waiting before
the run lock existed.

**Loop guards.** Seen 2026-09-16 in FoxTrack-Bridge: after reading a 145,000-char
file, the model emitted `read_file({"path":"mqtt/mqtt.go"})` 353 times in one turn
until the 8000-token budget cut it off mid-call. The old loop ran every call, kept
the half-written call, and sent a ~3.7M-token prompt; the server answered HTTP 500.
The guards:

- **Small tool-turn budget.** A turn that offers tools gets `toolTurnTokens`
  (default 1000), so a loop stops in seconds. When such a turn ends in plain text
  cut off by that budget, it is a long answer, not a loop: the same turn is asked
  again with `maxTokens`. That costs the first 1000 tokens again (about 20 s); the
  prompt itself is prefix-cached.
- **Broken turns are thrown away.** A turn is broken when it is cut off while
  calling tools, makes more than 10 calls, or holds a call whose arguments are not
  a JSON object. It never enters the transcript. The turn is retried once with a
  note saying why. If the retry breaks too, tools are withdrawn and the model is
  told to answer; the report gets a `WARNING:`. Both count as `turn(s) thrown away`.
- **Each distinct call runs once.** Duplicates inside a turn are dropped from the
  transcript. A call repeated from an earlier turn gets "Already done in an earlier
  turn ..." instead of the result. Calls are compared after normalising the path
  (`./a.ts` = `a.ts`, a missing path = `.`). Both count as `repeated call(s)
  skipped`.
- **Repeats end tool use.** From the usage log, 2026-09-15 to 09-20: 7 of 13 asks on
  FoxTrack-Bridge and foxtrack ran all 20 turns (158–947 s), three of them with 1, 16
  and 20 repeated calls. The model had nothing new to look up and still did not
  answer. Now the repeat note ends with "If you have nothing new to look up, answer
  now in plain text", and 2 turns in a row whose every call repeats an earlier one
  withdraw the tools and ask for the answer. STATUS then says `tool use ended on
  repeats`; it is not a WARNING, because nothing was left unread. A turn that mixes a
  repeat with a new call does not count. Measured 2026-09-22 on the real model: in
  4 asks, two of them loose questions of the kind that ran 20 turns before, the
  model answered on its own by turn 9 at the latest, and the guard never had to
  fire. It stays as the backstop.
- **Prompt size before every call.** If `prompt + maxTokens` would pass `ctx`, the
  call is not sent and the run fails with `prompt ... exceeds the ... context
  ceiling`. Tool results are sized against the room left, so this is a backstop.
- **Presence penalty 1.0.** Qwen's guidance for Qwen3 is that greedy-like decoding
  can repeat without end, and a presence penalty counters it. Measured in the 2026-09-16 table under "Model and sizing": no harm seen, but no loop occurred in either arm, so it is not proven to prevent one.

- **Listing is reliable; counting is not.** With reasoning off, a total over
  roughly 25 items drifts even when grep handed the model every match. Measured:
  a 94-item route count came back as 82, with the error entirely in the largest
  bucket (GET 38 vs 50) while the four smaller buckets were exact. Ask for the
  list and count it yourself, or verify the total with your own `grep -c`.
- **`readBudget` is a cap, not a target.** The 22-blueprint inventory used 3 of 40.
  Raise it freely; a high budget costs wall-clock only if the model spends it.
- **`maxReadChars` is the lever that matters for big files.** At the default 40,000
  a 70 KB source file still loses its middle. Pass `--max-read-chars 80000` (or
  more) to read it whole — measured working, with correct recall from the middle.
- **The answer budget does not grow.** `maxTokens` (default 8000) caps the answer;
  a `finish_reason: length` is not retried, it prints a `WARNING:` and a truncated
  answer. For a long inventory pass `--max-tokens 16000` up front.
- **Turns are cheap.** llama-server prefix-caches the KV, so an appended-to
  transcript re-prefills only its new tail. Measured: an identical 3,508-token
  prompt sent twice gave `prompt_n 3508 / cache_n 0`, then `prompt_n 4 / cache_n 3504`.

Boundary paths (auth, migrations, ...) are readable in ask mode. The boundary
protects against writes, and an inventory of auth checks needs to read them.

## Bookkeeping

Every run appends one line to `~/.local/state/delegate-to-local/usage.jsonl` (`mode`, status,
and for write: passes, attempts, files, `patch`; for ask: turns, reads, greps,
`answerChars` (what the caller pays for in its own tokens), `ctxTok` (the transcript
size at the end, what the model paid for), and
`discarded` / `repeats` / `stalled` when a loop guard fired, `forced` (`turns` or
`context`) when the answer was forced, `maxTurns`, and the first 200 chars of the
`question`; for a failed write, `note`; `waited` when the run queued; elapsed) so the
offloading stays measurable and the next round of tuning can see which questions
run long. `DELEGATE_USAGE_LOG=<file>` redirects it; the
test suite uses that so test runs never land in the real history.

## Testing the script itself

`test/run.sh` in the skill directory runs 188 deterministic tests against a scripted
mock server on port 18081 — no local model and no GPU needed, about 30 seconds. `bun run
typecheck` in the same directory type-checks the script. The mock serves two model
ids and a `/props` endpoint; the tests pick a model through `DELEGATE_MODEL`, ignore
your config file, and redirect the usage log and the lock directory, so they run the
same on every machine and never touch a real run.
