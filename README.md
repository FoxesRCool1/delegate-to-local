# delegate-to-local

A skill for Claude Code (and any agent that reads `SKILL.md` skills) that hands
work to a local LLM, so the cloud model spends its tokens on the contract and the
decision, not on typing or reading code.

Two modes, one script, one short report.

- **Write mode.** The agent writes a contract and a spec. The local model writes or
  patches the files. A script gates them (tsc + eslint, or any command you name),
  checks the contract, has the model review its own output, retries with the
  errors fed back, and prints a few-line report. Nothing is committed.
- **Ask mode.** The agent asks one question. The local model greps, lists and reads
  the repo itself and answers with `path:line` citations. File contents go into the
  local model's context, never into the agent's.

```
Agent                            delegate-loop.ts                    local model server
-----                            ----------------                    ------------------
decide it fits          ->       spec check, boundary check
write contract + spec   ->       gate pre-flight
                                 prompt (task + checks + context)  -> generate file (or edits)
                                 apply, shrink guard, write to disk
                                 gate + contract checks
                                 (errors fed back, retry)          -> corrected file
                                 self-review                       -> OK | defects
                                 one fix attempt, rollback if not green
read report             <-       SUMMARY / REVIEW / STATUS lines
```

```
Agent                            delegate-loop.ts --ask              local model server
-----                            ----------------------              ------------------
write one question      ->       system prompt + question           -> grep / list_dir / read_file
                                 run tools (sandboxed to root,
                                 read budget, caps, loop guards)    -> ... more tools ...
                                                                    -> answer
read answer             <-       answer + WARNING? + STATUS line
```

## What you need

- **[bun](https://bun.sh)** to run the script.
- **A local model server** that speaks the OpenAI chat API with streaming and tool
  calls: llama.cpp's `llama-server`, [llama-swap](https://github.com/mostlygeek/llama-swap),
  Ollama, LM Studio, vLLM.
- **A model that follows instructions and calls tools.** Everything in these docs
  was measured with Qwen3.8-27B (Unsloth UD-Q4_K_XL) on a 24 GB GPU with thinking
  off; `examples/llama-swap.config.yaml` is that setup. Smaller instruction-tuned
  coders should work; they are not measured. Do not use a thinking or vision build.
- Optional: [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) for faster
  grep that respects `.gitignore`.

## Install

Paste this to your agent:

> Install the delegate-to-local skill: run `git clone https://github.com/FoxesRCool1/delegate-to-local ~/.claude/skills/delegate-to-local && ~/.claude/skills/delegate-to-local/install.sh`. If the installer cannot pick a model, re-run it with `--url` and `--model` for my local model server. Then run the smoke test it prints and tell me the result.

Or by hand:

```sh
git clone https://github.com/FoxesRCool1/delegate-to-local ~/.claude/skills/delegate-to-local
~/.claude/skills/delegate-to-local/install.sh                     # add --url URL --model NAME if it cannot guess
```

The installer links the clone into `~/.claude/skills/` if it lives elsewhere
(`--skill-dir` for another agent's skills folder), runs `bun install`, asks your
server which models it serves, writes `~/.config/delegate-to-local/config.json`,
and prints a smoke-test command. It never touches your projects.

## Setup

Three settings. First match wins: **flag > environment > config file > detection >
built-in**.

| Setting | Flag | Env | Config key | Detected from | Built-in |
|---|---|---|---|---|---|
| server URL | `--url` | `DELEGATE_URL` | `url` | — | `http://127.0.0.1:8080` |
| model id | `--model` | `DELEGATE_MODEL` | `model` | the only model the server lists | — |
| context ceiling (tokens) | `--ctx` | `DELEGATE_CTX` | `ctx` | `/props` on llama-server, `/upstream/<model>/props` behind llama-swap | 32768 |

`~/.config/delegate-to-local/config.json` looks like this:

```json
{ "url": "http://127.0.0.1:8080", "model": "qwen3.8-27b-delegate" }
```

- **llama-server / llama-swap:** the context size is read from the server. Nothing
  else to set.
- **Ollama, LM Studio, vLLM:** add `"ctx"` with the model's real context length.
  Ollama defaults to a small context and cuts an oversized prompt without a word,
  and the head of the prompt is where the contract lives. Raise Ollama's
  `num_ctx` (or `OLLAMA_CONTEXT_LENGTH`) and set `ctx` to match.
- The script serves one run at a time per server URL (a lock file in
  `~/.cache/delegate-to-local/`). A second run waits and says so in its report.
- `DELEGATE_CONFIG`, `DELEGATE_USAGE_LOG` and `DELEGATE_LOCK_DIR` move the config
  file, the usage log (`~/.local/state/delegate-to-local/usage.jsonl`, one line per
  run) and the lock directory.

## Use

The agent reads `SKILL.md` and decides when to delegate. Say things like
"delegate this", "ask the local model", "find every X in this repo", or "build X
with the local LLM". It will write the spec or the question, run the script in the
background, and read the report.

By hand:

```sh
S=~/.claude/skills/delegate-to-local
$S/scripts/delegate-loop.ts examples/single.json --log /tmp/run.log
$S/scripts/delegate-loop.ts --ask "list every env var read via process.env, path:line" --root ~/src/app --read-budget 40
tail -500 build.log | $S/scripts/delegate-loop.ts --ask "which 3 errors block the build?" --root . --stdin
$S/scripts/delegate-loop.ts --help
```

Write mode needs either `tsconfig.json` plus an eslint config in the target
project (the default gate) or a `verify` gate in the spec: any commands, for any
language. `examples/` has a single pass, a multi-pass batch, a Python pass with a
`verify` gate, and an ask spec.

## Files

| Path | Role |
|---|---|
| `SKILL.md` | What the agent reads on every use: when to delegate, how to run either mode, how to ask. |
| `write.md` | Read before a write-mode spec: sizing, the contract, the spec format, the report, the failure table. |
| `reference.md` | Detail: spec fields, settings, assert forms, gates, guards, ask-mode tools and caps, every measured run. |
| `scripts/delegate-loop.ts` | The loop. `--help` prints the spec format, the flags and the settings order. |
| `install.sh` | Installer. |
| `examples/` | Four specs and the reference llama-swap config. |
| `test/run.sh` | 188 deterministic tests against a scripted mock server. No model or GPU needed. |

## What it protects

- **Hard boundary.** Paths naming auth, migrations, RLS, security definer,
  entitlements or `.server.*` are refused for writing, both on the declared scope
  and on anything the model returns. Ask mode may read them. The lists are
  `BANNED_TOKENS`, `BANNED_TOKEN_PAIRS` and `SERVER_SUFFIX_RE` near the top of the
  script; edit them there if your project uses those names for something else.
- **Sandbox.** Every path is resolved inside the project root. Ask-mode tools refuse
  paths that escape it, binaries, and files over a byte cap.
- **Nothing is committed or pushed.** Files from green passes stay on disk for you
  to review with `git diff`.
- **A typo does not pass in silence.** Unknown spec keys, an assert on a file
  outside `scope`, a missing `context` file, and an unknown config key are refused
  before any model call.

## Measured

On the reference setup (Qwen3.8-27B, 24 GB GPU, 96k context), no generated code
read by the agent. The full tables are in `reference.md`.

| Job | Result | Time |
|---|---|---|
| 366-line tokenizer + Pratt parser + evaluator, 32-test gate | green; 19/20 right on edge cases the gate never tested | 146 s |
| 117-line RFC 4180 CSV parser, 31-test gate, then a second pass adding a function | green; review caught one contract ambiguity | 67 s |
| 6-pass batch, 252 lines over 6 modules | 6/6 green, first try each | 45 s |
| 3 patch-mode edits to a 2,756-line / 153 KB HTML file | green, diff exactly `+9/-1` | 86 s |
| Ask: every HTTP route in a Go server (27) | 27/27, every `path:line` exact, no file read | 17 s |
| Ask: 4-part "how is an order created" in a 1,700-file app | right; 5 of 7 citations exact, 2 off by a few lines | 97 s |
| Ask: count 94 route decorators by method | **wrong total** (82). It lists well and counts badly; count the list yourself | 6 s |

## Test

```sh
bun run typecheck
test/run.sh
```

188 tests, about 30 seconds, no model and no GPU: green first try, review finds a
defect and the fix passes, a review fix that breaks the gate is rolled back, budget
bumps on truncation, misspelt keys refused, a gate that cannot start or hangs, the
shrink guard, patch mode (missed SEARCH fed back, indentation repair, ambiguous
SEARCH refused), ask mode (read budget, sandbox, runaway turns thrown away,
repeated calls run once, a broad grep summarised to per-file counts, forced
answers flagged), the run lock, and the settings order (env, config file, server
detection, several models with none chosen).

## Design notes

- **The contract is the quality lever.** `assert` entries are listed in the model's
  prompt up front and checked after the gate; a miss is fed back like a compiler
  error. Plain strings are literal, whitespace-tolerant text, so there is no regex
  escaping to get wrong.
- **Self-review after green.** A fresh conversation judges the file against the
  contract. Findings get one fix attempt through the same gate; a fix that is not
  green is rolled back. Review can slow a pass down but cannot make it worse.
- **No middle layer.** An earlier version dispatched a cloud subagent to write the
  spec and run the loop. It cost more tokens than it saved and lost contract
  fidelity on the way through. The agent runs the script in the background and
  reads a report that is a few lines long.
- **One run at a time.** A local server has one slot, so parallel runs only queue
  and look hung. A lock file per server URL makes a second run wait and say why.
- **Ask-mode loop guards.** The model once emitted the same `read_file` call 353
  times in one turn. Now tool turns get a small token budget, a broken turn is
  thrown away and retried once, each distinct call runs once, two turns of only
  repeated calls end tool use, and every prompt is size-checked before it is sent.
- **A broad grep comes back as counts.** The model's first grep is often a common
  word over the whole repo. Over 200 matches the tool returns matches per file, and
  the model drills in with a path or a tighter pattern. Measured: 42,318 chars down
  to 3,438 on the same question.
- **Patch mode applies to the original.** Every attempt re-sends all its edits and
  they are applied to the file as the pass found it, all or nothing, so a failed
  attempt never leaves half an edit on disk.
- **Every run ends in a STATUS line.** A gate that cannot start, one that hangs, a
  server that is down, and an unexpected throw all come back as a report, because
  the report is the only thing the agent reads.

## Support

If this saves you tokens, you can buy the author a coffee:
[ko-fi.com/foxesrcool](https://ko-fi.com/foxesrcool).

Issues and pull requests are welcome at
[github.com/FoxesRCool1/delegate-to-local](https://github.com/FoxesRCool1/delegate-to-local).

## License

MIT. See `LICENSE`.
