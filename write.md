# Write mode

Read this before you write a spec. `SKILL.md` has the decision and how to run the
script; `reference.md` has the detail behind every rule here.

| Who | Does |
|---|---|
| You | Size it. Write the contract and spec. Read the report. |
| Script | Spec check, boundary check, gate pre-flight, prompt, shrink guard, gate, contract checks, self-review, retries, report. |
| Local model | Writes the complete files. Reviews its own output against the contract. |

## 1. Size the pass

Each file is emitted **complete in one reply**, so `maxTokens` is a real ceiling.
In patch mode only the edit blocks are emitted, so size `maxTokens` by the edited
lines, not the file.

```
maxTokens = target lines x 9          (~7.5 tokens per line, plus headroom)
```

- Default 8000 ≈ **1000 lines**. Ceiling 32000 ≈ **3500 lines**. On truncation the
  script doubles the budget up to 4 times on its own without spending a retry, so
  sizing right saves wall-clock but is not a correctness risk.
- Reached in practice: 567 lines in one file from a 92-line contract.

Context: the pre-flight refuses when `estimated prompt + maxTokens > 98304`,
estimated at `chars / 3.5`.

```
context chars <= (98304 - maxTokens) x 3.5      ~= 316,000 at maxTokens 8000
prefill time  ~= context chars / 1900           ~= 1 s per 1,900 chars
```

- **`chars / 3.5` only holds for source code.** JSON is 2.5, lockfiles 1.9,
  minified 1.5, base64 1.3. Dense data can pass the pre-flight and still overflow
  the server, which drops the head of the prompt — where your contract lives.
  Keep lockfiles, minified assets and big JSON fixtures out of `context`.
- Self-review does **not** re-send `context`, only the generated file (in patch
  mode, only the diff). Leave it on.
- The context check runs **before every model call**. When retries grow the
  transcript past the ceiling, the oldest attempts are dropped. If even the first
  prompt does not fit, the pass stops with `prompt exceeds context ceiling`.

## 2. Write the contract

`task` has no length limit — a 92-line contract produced a correct 567-line file.
Include:

- Each file path, and that the model must emit the COMPLETE file.
- Every exported name with its full signature.
- The API idiom to follow, naming the function or pattern in a `context` file.
- Error and edge behaviour, one line each ("empty input returns []").
- For an edit: what is replaced, and every member that must NOT change.
- **Index/offset math as literal code, not prose.** A wrong-but-plausible formula
  compiles clean and passes every gate. Work it out yourself.
- For a multi-section contract, number the sections and say up front: "Do not
  abbreviate, do not write a placeholder, and do not stop early."

**Ambiguity in the contract is the only failure mode observed.** In both a
366-line and a 567-line run, the single thing the model got wrong was the one
rule stated without a worked example — and the self-review flagged exactly that
spot both times. Where two readings exist, pin it: `-2^2 is -4`, `2^-3 is 0.125`. A rule also
needs its reach: "do not use regular expressions for parsing" was applied by the
review to a `replace(/"/g, ...)` in the stringify function of the same file
(2026-09-22), and cost a fix round. Say which functions a rule covers.

Never paste file bodies into `task`. Put the file in `context`; the script shows
it to the model. That is the cost you are avoiding.

## 3. Write the spec

Write it to your scratchpad directory, never into the target project.

```json
{
  "root": "/abs/path/to/project",
  "passes": [
    {
      "name": "money",
      "task": "Create src/utils/money.ts and src/utils/money.types.ts ...",
      "scope": ["src/utils/money.ts", "src/utils/money.types.ts"],
      "context": ["src/types/cart.ts"],
      "maxTokens": 8000,
      "assert": [
        { "text": "export function formatCents(cents: number): string", "file": "src/utils/money.ts" },
        { "text": "export interface Money", "file": "src/utils/money.types.ts" },
        { "text": "export default", "absent": true }
      ]
    },
    {
      "name": "cart",
      "task": "Edit src/cart.ts: replace the inline toFixed(2) with formatCents ...",
      "scope": ["src/cart.ts"],
      "context": ["src/utils/money.ts"],
      "assert": [
        "import { formatCents } from \"./utils/money\"",
        { "text": "toFixed(2)", "absent": true },
        "export interface CartLine",
        "remove(sku: string): boolean"
      ]
    }
  ]
}
```

**The script checks the spec before any model call** (`STATUS: aborted`, exit 4):
an unknown or misspelt key (`asserts`, `contexts`, `max_tokens`) is refused with
the right name, and an assert `file` must be one of the pass's `scope` paths. A
`context` file that does not exist fails its pass in 0 s with
`note="context file not found"`. The keys are exactly: `root`, `model`, `passes`;
per pass `name`, `task`, `scope`, `context`, `assert`, `verify`, `eslintScope`,
`maxTokens`, `allowShrink`, `patch`, `review`. With `passes`, only `verify`,
`eslintScope`, `maxTokens`, `allowShrink`, `patch`, `review` may sit at the top
level as defaults.

- **`scope` may list several files.** Group a file with what exists only to serve
  it (its types, its barrel). Use separate passes when a later file needs an
  earlier one's finished text in `context`, or when each needs its own gate.
- **Order passes so dependencies come first.** One spec per feature, never a shell
  loop: the model loads once for the whole batch.
- **The batch is fail-fast.** The first non-green pass stops it. Later passes never
  run and never appear in the report; files from green passes, and the last
  failing generation, stay on disk. Put the riskiest pass first.
- **`assert` on every pass.** Plain strings are literal, whitespace-tolerant text
  that must appear. `{"text": ..., "absent": true}` must not appear.
  `{"text": ..., "file": ...}` pins a check to one file — **use it on every
  positive check whenever `scope` has more than one entry**, or a pass that dumps
  everything into one file still passes. Anchor only on text you dictated
  character for character: signatures, imports, exported names, literal error
  strings. Never on prose or comments. For an edit, assert each member that must
  survive plus an `absent` for what is replaced.
- **Gate.** Default is `tsc` + scoped eslint, and it needs BOTH `tsconfig.json`
  and an eslint config in `root` or the script aborts with exit 4 before calling
  the model. Everything else sets `verify`: argv arrays, absolute tool paths, only
  check files that already exist. **A gate command must end on its own** —
  `vitest run`, not `vitest`; no watch mode, no prompt. One that runs past
  `--gate-timeout` (300 s) is killed and counts as failed. Check `root` first.
  Details in `reference.md`.
- **In a batch, gate each pass on its OWN work.** A shared gate over the whole
  suite can never go green on pass 1, because later passes have not written their
  files yet, so the pass burns every retry on correct code. Filter by test name
  (`-k TestUnits`) or give each pass its own test file.
- Optional per pass: `maxTokens`, `allowShrink` (a pass meant to delete code),
  `review: false`, `patch: true`.
- **`patch: true` for an edit to a big file** — anything over ~1500 lines, or any
  file whose whole re-emit would not fit `maxTokens`. The model answers with
  `<<<EDIT path>>> <<<SEARCH>>> old <<<REPLACE>>> new <<<END>>>` blocks, applied to
  the ORIGINAL file every attempt, all or nothing. SEARCH must match exactly one
  place; a miss is fed back with the real numbered lines. Gate, `assert`, shrink
  guard and review (shown the diff) are unchanged. In the task, name each change
  and where it goes ("directly after the closing brace of function X"); assert the
  new text and the neighbours that must survive. More in `reference.md`.

## 4. Flags

Run it as `SKILL.md` section 2 says. Write-mode flags:

- `--allow-dirty-gate` — needed when `scope` is a NEW file the gate already refers
  to (a module the project or its tests already import). Without it the pre-flight
  aborts at `gate already failing before any change` in 0 s. Only for that shape.
- `--max-retries N` (default 5). Lower it only to cap wall-clock.
- `--max-tokens N` — prefer the per-pass `maxTokens`; use this to raise all passes.
- `--gate-timeout N` (default 300 s per gate command). Raise it only for a gate
  that is slow but correct.
- `--model` / `--ctx` — leave off. Defaults already match the server.
- `--diff` to see what was written, `--no-review` to skip the self-review.

## 5. Read the report

```
SUMMARY: pass=money status=green files=src/utils/money.ts:42L(new),src/utils/money.types.ts:9L(new) gate=tsc+eslint attempts=1 asserts=3/3 review=OK elapsed=14s
STATUS: green — 2/2 pass(es) verified in 25s. Nothing was committed. Log: ...
```

- `asserts=k/n` is the contract check. `review=` is `OK`, `fixed`, or
  `kept-verified` (the fix failed the gate, so the verified version stayed and a
  `REVIEW:` block lists what it found).
- `files=` gives line counts and `+added/-removed`. A `+2/-1` where you expected
  `+40` means the pass did less than asked. A large `-` means it dropped code.
- Paths are project-relative. Report them as printed.

**A `REVIEW:` block points at contract ambiguity, not at a verdict.** Reasoning is
off in this build and the review is capped, so on hard logic the prose rambles and
can argue with itself. Read it for *where* it is uneasy. `kept-verified` means the
rollback guard worked, not that the pass is bad.

**Then check the cheap way.** Do not re-read the generated file to "make sure" —
that re-imports what you delegated to keep out.

1. If there is a `REVIEW:` block, read it. If it names an ambiguity, fix the
   contract, not the code.
2. Run one smoke test on the new code path with the project's own runner. The gate
   proves syntax and the contract; the smoke test proves behaviour.
3. For an edit in a git repo, `git diff --stat -- <file>`. Read the diff only if
   the counts look wrong.

Tell the user: the files, the gate and review results, what is still unverified,
and the smoke test you ran or suggest. Do not commit or push.

## 6. On failure

`STATUS: failed`, and `note=` on the SUMMARY line names the cause:

| note | Fix |
|---|---|
| `gate already failing before any change` | Read the errors under STATUS. `cannot run "<tool>"` → wrong path in `verify`. `timed out after Ns` → the gate does not end on its own. New file the gate already imports → `--allow-dirty-gate`. Otherwise fix the project's gate, not the spec. |
| `context file not found` | A path in `context` is wrong. The report lists it. |
| `prompt exceeds context ceiling` | Trim `context` or lower `maxTokens`. Check for dense data (section 1). |
| `still truncated ... after 4 budget bump(s)` | Budget already hit 32000, so the file is over ~3500 lines. An edit to an existing file → `"patch": true`. A new file → split across passes writing **different** files. |
| `boundary violation` | Off limits. Hand it back to the user. |
| (none, `retries exhausted`) | Read the errors under STATUS: an assertion on text it cannot emit verbatim, an ambiguity in the contract, or a gate that `timed out` on an endless loop in the generated code. |

`STATUS: aborted — ...` is a setup problem and names its fix: a bad spec key, a
missing `tsconfig.json`, the server down, or `another delegate-loop run ... still
holds the model` (exit 3 — wait for it, then re-run).

Tighten and re-run, at most twice per file. Then report plainly and ask the user.
Do not silently take over and write it yourself; that defeats the point.
