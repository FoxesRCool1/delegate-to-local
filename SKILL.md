---
name: delegate-to-local
description: Hand work to your local LLM (llama.cpp, llama-swap, Ollama, LM Studio, any OpenAI-compatible server) instead of spending Claude tokens on it. WRITE - you write a contract, the local model writes or patches the files, a script gates and reviews them, you read a few-line report. ASK - the local model greps and reads the project itself and answers, so file contents never enter your context. Offer it unprompted whenever work fits, and go big - several files and ~1000 lines per pass, many passes per spec, 200,000 chars of context, patch mode for files too big to re-emit. Triggers: "delegate this", "hand this to the local model", "ask the local model", "build X with the local LLM", "find every ..." in a large repo.
---

# Delegate to Local

Two modes, one script, one report.

| Mode | Use it for | You write | You get back |
|---|---|---|---|
| **write** | Files to create or edit | A contract and a spec | SUMMARY/STATUS lines |
| **ask** | A question answered by reading the repo | One question | The answer and a STATUS line |

**Write mode: read `write.md` (next to this file) before you write a spec.** It has
the sizing, the contract rules, the spec format, the report and the failure table.
Never write a spec from memory: the script rejects unknown keys, and a vague
contract is the only failure mode observed. This file covers the decision (1),
running either mode (2) and ask mode (3).

Quality comes from the contract. The script can only enforce what you put in
`task` and `assert`. Spend your tokens there, not on reading generated code. Every
number here is measured; the runs are in `reference.md`.

## 1. Delegate or not?

**Default to delegating, and aim high.** The limit is whether you can write a
checkable contract, not how much code there is. Overhead is ~500 tokens per pass.
Size costs the local model wall-clock, which is free, not your tokens.

**Delegate**
- Any self-contained work you can state a contract for: components, parsers,
  protocol or algorithm modules, helpers, docs, test suites, fixtures, config
  generators, whole small subsystems.
- Hard logic: a 366-line tokenizer + Pratt parser + evaluator went green in 146 s.
  A 117-line RFC 4180 CSV parser against a 31-test gate: green first try, 30 s.
- Several files in one pass (types + implementation + barrel: green in 10 s), and
  many passes in one spec (the model loads once; 6 passes went 6/6 in 45 s). A
  file too small for its own run is still worth adding to a batch.
- A lot of context: 188,466 chars across 12 files, 11 exact constants recalled.
- Mechanical refactors, and scoped edits when you can name every member that
  must survive. For a big existing file, `"patch": true` sends SEARCH/REPLACE
  blocks, so a 150 KB `ui.html` can still be delegated.

**Make it delegable before you give up**
- No mechanical gate? Write the test file yourself, then delegate the
  implementation against it. That gates every retry automatically.
- Contract too vague? Ask ONE clarifying question, then proceed.
- Don't know the codebase well enough? **Use ask mode first** (section 3) to get
  the exact paths and signatures, then write the spec from its answer.

**Write it yourself — these do not move**
- Boundary files: migrations, RLS, security-definer RPCs, auth, `.server.ts`,
  entitlements. The script refuses these; never route around it.
- Work needing live judgement you must own, or design you cannot pin down.
- A one-line edit, unless it joins a batch you are already writing.

## 2. Run it (both modes)

```sh
W=<your scratchpad dir>
S=~/.claude/skills/delegate-to-local          # this skill's directory; the script is scripts/delegate-loop.ts inside it
$S/scripts/delegate-loop.ts "$W/spec.json" --log "$W/run.log"                      # write
$S/scripts/delegate-loop.ts --ask "<question>" --root /abs/path --log "$W/ask.log"  # ask
```

- Run it with `run_in_background: true` and a 900000 ms timeout, then carry on. Do
  not poll. When the notice arrives, Read the output file it names — that is the
  whole report, a few lines. Never `cat` the log; the errors are in the report.
- Call the script by that direct path. `bun run ...` gets rewritten by hooks and
  the report comes back mangled.
- **No server pre-check.** The script finds the server, the model and the context
  size itself (from `~/.config/delegate-to-local/config.json`, `DELEGATE_URL` /
  `DELEGATE_MODEL` / `DELEGATE_CTX`, or `--url` / `--model` / `--ctx`) and reports
  `STATUS: aborted — cannot reach the model server ...` (exit 3) with the setting to
  fix. Do not probe the server first. Never point it at a thinking or vision build:
  the loops need plain answers and tool calls.
- **One run at a time.** The server has one slot. Runs started together queue; they
  do not go faster. The script holds a lock: a second run waits (`--lock-wait`,
  default 1800 s) and its report gets a `NOTE: waited Ns ...` line. Put several
  passes in one spec, and start the next ask when the last one reports.
- Every report ends in a `STATUS:` line. `STATUS: aborted — ...` is a setup problem
  (bad spec key, missing file, server down, lock) and names its own fix.

## 3. Ask mode (read-only)

The model explores with `read_file`, `list_dir` and `grep`, sandboxed to the root,
and answers. Nothing is written. The files it reads go into its context, not yours.

**Use it for** inventories and "find every X"; orientation in a repo you do not
know; content audits across many files; log or build triage with `--stdin`; and
**getting the exact signatures and paths for a write-mode spec**, which is the
cheapest way to make a big delegation possible.

**It is excellent at locating, listing and quoting.** 27 of 27 HTTP routes in a Go
server, every path:line right, in 17 s with no file read; 22 of 22 Flask blueprints
in a 3,650-file repo, including three declared across multiple lines.

**Do not trust it to COUNT a large set.** With reasoning off, totals over roughly
25 items drift (a true 50 came back as 38, from a grep that had handed it every
match). **Ask it to LIST, then count the list yourself**, or check with `grep -c`.

**Do it yourself when** the answer needs judgement you must own, needs this
conversation's context, or is one Grep away. For a verdict, treat its answer as a
first pass and spot-check the load-bearing findings.

### Write the question

Measured 2026-09-22 on a 1,700-file app: a 4-part "how is an order created"
question with a stop clause answered in 9 turns / 97 s with a 1,400-char answer;
"How do notifications work in this app?" answered in 7 turns / 82 s with a
5,000-char answer. **The answer lands in your context**, so a loose question costs
you about four times the tokens of a focused one. Time grows with what the model
reads: every file it reads stays in its context for every later turn, and the model
now sees only per-file counts for a grep with over 200 matches, so it drills in
instead of dumping.

- **One topic per ask.** Split a multi-part question when the parts touch different
  files. They run one after another anyway, and each one finishes sooner.
- **Say what a complete answer is**, so it knows when to stop and how much to
  write: "List each handler as path:line with its HTTP method. Stop when you have
  covered `server/routes/`." For a verdict: "Answer in under 150 words."
- **Name the files, directories and functions you already know.** Each one saves a
  turn of searching.
- For a huge file say "grep it, do not read it". Ask for `path:line` citations when
  you want to verify. Do not paste file contents into the question.
- A long question goes in a spec file: `{ "root": ..., "ask": "...", "readBudget": 30 }`.

### Flags

- `--read-budget N` (default 15) caps `read_file`; `grep` and `list_dir` cost no
  reads. **Use 40 for any inventory.** It is a cap, not a target: the 22-blueprint
  run used 3 of 40, the 27-route run 0 of 40.
- `--max-read-chars N` (default 40000): a longer file is cut to head 60% / tail 40%
  and the marker names the dropped line range. **Raise it to read a large file
  whole** (a 70,000-char file at 80000 was quoted correctly from its middle). Do not
  raise it past what the question needs: at 160000 one 150 KB HTML file added
  ~43,000 tokens to every later turn.
- `--max-tokens N` (default 8000) is the answer budget. Ask mode does not grow it
  and does not retry. For a big inventory pass `--max-tokens 16000` up front.
- `--max-turns N` (default 20). The model is told its turn limit, and told again at
  60% of it. Before the 2026-09-21 guards, 7 of 13 real asks ran all 20 turns; the 4
  asks measured since all stopped on their own by turn 9. A STATUS that shows all
  20 turns means the question was too loose: narrow it.
- `--stdin` attaches piped input:
  `tail -500 build.log | ... --ask "which 3 errors block the build?" --stdin`.
- Loop guards need no flags (detail in `reference.md`): broken or runaway turns are
  thrown away, each distinct call runs once, and two turns in a row that only
  repeat earlier calls end tool use.

### Read the answer

```
STATUS: answered — 4 turn(s), 3 file(s) read of 40, 2 grep(s), 1 list(s), 41s. Log: ...
```

- **A `WARNING:` line before STATUS says what went short and what to do.** Relay it
  with the answer.
  - `used all N turns` or `the context filled up`: the model did not choose to
    answer; it was made to. **Treat the answer as partial.** Re-ask the missing part
    as its own narrower question rather than raising the limits.
  - `read budget exhausted`, `the answer was cut off`: re-run with the flag it names.
  - `tool calls broke twice in a row`: the answer covers only what it had read.
- `N repeated call(s) skipped`, `N turn(s) thrown away`, `tool use ended on repeats`
  in STATUS mean a loop guard fired. The answer is still usable.
- Spot-check a cited `path:line` when the answer will drive a change. Lines that
  point at a call or a statement were exact in every measured run; lines that point
  at a function's start were off by a few lines about 1 time in 4.

Model facts, sizing, gates, guards and every measured run: `reference.md`.
