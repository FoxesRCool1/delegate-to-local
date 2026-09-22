#!/usr/bin/env bun
/**
 * delegate-loop — hand work to a local model and print a short report.
 *
 * Two modes:
 *   write  a spec with "task"/"scope" (or "passes"): the model writes the scope
 *          files of each pass (whole files, or SEARCH/REPLACE edits with
 *          "patch": true), the script gates them, the model reviews them, errors
 *          are fed back, and nothing is committed.
 *   ask    a spec with "ask" (or --ask "question"): the model explores the project
 *          with read_file / list_dir / grep and answers. Nothing is written. File
 *          contents stay in the local model, not in the caller's context.
 *
 * One run at a time per server: the server has one slot, so a second run waits on
 * a lock file and says who it is waiting for.
 *
 * Usage:
 *   delegate-loop.ts <spec.json> [options]
 *   delegate-loop.ts --ask "question" --root DIR [options]
 *
 * Options:
 *   --root DIR           Target project root (overrides spec.root)
 *   --model NAME         model id (else spec.model, DELEGATE_MODEL, the config file, the only served model)
 *   --url URL            server base URL (else DELEGATE_URL, the config file, http://127.0.0.1:8080)
 *   --max-retries N      write: retries after the first attempt (default: 5)
 *   --max-tokens N       Generation budget per model call (default: 8000; write mode auto-grows it)
 *   --ctx N              Server context ceiling, checked before every model call (else DELEGATE_CTX, the config file, the server's /props, 32768)
 *   --log FILE           Write progress to FILE instead of stderr. stdout is then the report only.
 *   --lock-wait N        Seconds to wait for another run to finish (default: 1800; 0 = do not wait)
 *   --diff               write: print a unified diff of every file written, after the report
 *   --no-review          write: skip the model's self-review pass
 *   --allow-dirty-gate   write: continue even if the gate already fails on the UNCHANGED tree
 *   --gate-timeout N     write: seconds one gate command may run before it is killed (default: 300; 0 = no limit)
 *   --ask QUESTION       ask mode without a spec file
 *   --read-budget N      ask: max read_file calls (default: 15; list_dir and grep are free)
 *   --max-turns N        ask: max model turns (default: 20)
 *   --max-read-chars N   ask: per-file char cap before head/tail truncation (default: 40000)
 *   --max-file-bytes N   ask: refuse to read files larger than this (default: 500000)
 *   --tool-turn-tokens N ask: generation budget of a turn that may call tools (default: 1000)
 *   --presence-penalty N ask: sampling presence penalty (default: 1.0)
 *   --stdin              ask: attach stdin to the question (log triage: `tail -500 x.log | ... --stdin`)
 *   --help               Show this message
 *
 * Spec (JSON), ask mode:
 *   { "root": "/abs/path", "ask": "List every env var read via process.env, file:line",
 *     "readBudget": 15, "maxTurns": 20 }
 *
 * Spec (JSON), write mode, one pass:
 *   {
 *     "root": "/absolute/path/to/project",
 *     "task": "the contract: what to build, every name and signature, edge behavior",
 *     "scope": ["src/utils/money.ts"],           // the ONE file the model may write
 *     "context": ["src/types/money.ts"],         // read-only files shown to the model
 *     "assert": [                                // contract checks, fed back like compiler errors
 *       "export function formatMoney(cents: number): string",   // literal text (whitespace-tolerant)
 *       { "text": ": any", "absent": true },                    // must NOT appear
 *       { "regex": "^import .* from \"\\./types\"" }            // regex when you need one
 *     ],
 *     "verify": [["/usr/bin/python3", "-m", "py_compile", "x.py"]],  // custom gate; replaces tsc+eslint
 *     "eslintScope": ["src/utils/money.ts"],     // optional, defaults to scope
 *     "maxTokens": 4000,                         // optional
 *     "allowShrink": false,                      // optional, see shrink guard
 *     "patch": false,                            // optional, SEARCH/REPLACE edits instead of whole files
 *     "review": true,                            // optional, default true
 *     "model": "my-model"                        // optional
 *   }
 *
 * Spec, several passes: replace "task"/"scope"/... with "passes": [ {...}, {...} ].
 * Passes run in order in one process, so the model loads once, and a later pass
 * can list an earlier pass's output in its own "context". A failing pass stops
 * the batch. Top-level verify/eslintScope/maxTokens/allowShrink/patch/review are
 * defaults each pass may override.
 *
 * The loop, per pass:
 *   1. boundary check      scope/context may not name auth, migrations, RLS, .server.*, entitlements
 *   2. gate pre-flight     the gate must already pass on the unchanged tree
 *   3. generate            the model returns COMPLETE files in <<<FILE>>> blocks, or with
 *                          "patch": true, <<<EDIT>>> SEARCH/REPLACE blocks applied to the
 *                          original file (all or nothing)
 *   4. shrink guard        an edit that drops >50% of an existing file is rejected
 *   5. gate + asserts      tsc + scoped eslint (or `verify`), then the contract checks
 *   6. self-review         a fresh model call reviews the file (a diff, in patch mode)
 *                          against the contract; findings get one fix attempt, and a fix
 *                          that fails the gate is rolled back to the verified version
 *   Steps 3–5 repeat with the errors fed back until green or retries run out. Before
 *   every call the prompt is checked against --ctx; the oldest retries are dropped
 *   from the transcript to make it fit.
 *
 * Ask mode guards: a turn that may call tools gets a small budget
 * (--tool-turn-tokens). A turn that is cut off, makes more than 10 calls, or holds a
 * malformed call is thrown away and retried once; a second bad turn ends tool use.
 * Identical calls run once, and a repeat of an earlier call gets a short note, not
 * the result again. Two turns in a row that only repeat earlier calls end tool use.
 * At 60% of the turns the model is told how many are left.
 *
 * Output: progress on stderr (or --log FILE); the report on stdout.
 *   write:  SUMMARY: pass=<name> status=green|failed files=<path>:<N>L(<new|+a/-r>) gate=<g> attempts=<n> asserts=<k>/<n> review=<r> elapsed=<s>s
 *           REVIEW:  pass=<name> ... (only when the reviewer found something)
 *           STATUS:  green — ... | failed — <reason> ...
 *   ask:    <the answer>
 *           WARNING: ... (read budget exhausted, the answer was cut off, or the answer was
 *                    forced because the turns or the context ran out)
 *           STATUS:  answered — <n> turn(s), <k> file(s) read, ... | failed — <reason>
 *   either: STATUS: aborted — <reason>
 * Exit codes: 0 green/answered, 1 internal error, 2 failed, 3 server/model unavailable, 4 bad spec or setup.
 */

import {
  existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, writeSync, appendFileSync,
} from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

// Settings, first match wins: flag > environment > config file > detection > built-in.
//   url    --url    DELEGATE_URL    "url"    else http://127.0.0.1:8080
//   model  --model  DELEGATE_MODEL  "model"  else the only model the server lists
//   ctx    --ctx    DELEGATE_CTX    "ctx"    else the server's /props n_ctx, else 32768
const CONFIG_PATH = process.env.DELEGATE_CONFIG
  || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "delegate-to-local", "config.json");
const FALLBACK_URL = "http://127.0.0.1:8080";
const FALLBACK_CTX = 32_768;
const PROBE_TIMEOUT_MS = 300_000; // behind llama-swap, /props loads the model first
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_READ_BUDGET = 15;
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_READ_CHARS = 40_000;
const DEFAULT_MAX_FILE_BYTES = 500_000;
// One line per run. Tests point DELEGATE_USAGE_LOG at a temp file so they never
// pollute the real history.
const USAGE_LOG = process.env.DELEGATE_USAGE_LOG
  || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "delegate-to-local", "usage.jsonl");

// Run lock, one file per server. Tests point DELEGATE_LOCK_DIR at a temp dir.
const LOCK_DIR = process.env.DELEGATE_LOCK_DIR || join(homedir(), ".cache", "delegate-to-local");
const DEFAULT_LOCK_WAIT_S = 1800;
const LOCK_POLL_MS = 2000;
const LOCK_HEARTBEAT_MS = 15_000; // the holder touches its lock file this often
const LOCK_STALE_MS = 60_000;     // an untouched lock whose pid we cannot see is stale after this
const TICKET_STALE_MS = 10_000;   // a waiter touches its queue ticket every poll

const GEN_TEMPERATURE = 0.2;
const REVIEW_TEMPERATURE = 0.1;
const ASK_TEMPERATURE = 0.1;
// Qwen: near-greedy decoding can repeat without end; they suggest a presence penalty.
// Seen here as one read_file call emitted 353 times in a single turn.
const DEFAULT_PRESENCE_PENALTY = 1.0;
const DEFAULT_TOOL_TURN_TOKENS = 1000;
const MAX_TOOL_CALLS_PER_TURN = 10;
// Seen 2026-09-18/20: asks ran all 20 turns with 16-20 repeated calls. The model had
// nothing new to look up but never answered. Turns that only repeat calls end tool use.
const STALL_TURNS = 2;
const TURN_NUDGE_AT = 0.6;      // fraction of the turns used before the model is told how many are left
const TURN_NUDGE_MIN_TURNS = 6; // no nudge for a run this short
const DEFAULT_GATE_TIMEOUT_S = 300;
const REVIEW_DIFF_CONTEXT = 8;
const REVIEW_MAX_TOKENS = 1500;
const REQUEST_TIMEOUT_MS = 1_800_000; // 30 min; safe because chat() streams
const MAX_ERROR_CHARS = 12_000;
const MAX_REVIEW_CHARS = 1500;
const CHARS_PER_TOKEN = 3.5; // rough, for the prompt-size pre-flight only
const PREFILL_TOK_PER_SEC = 380;
const SHRINK_FLOOR = 0.5; // an edited file may not drop below this fraction of its lines
const SHRINK_MIN_LINES = 20;
const TRUNCATION_GROWTH = 2;
const MAX_BUDGET_BUMPS = 4;
const MAX_TOKEN_CEILING = 32_000;

// ---------------------------------------------------------------------------
// Logging. Progress goes to stderr, or to --log FILE. The report goes to stdout.
// ---------------------------------------------------------------------------

let logSink: (line: string) => void = (line) => console.error(line);

function log(msg: string) {
  logSink(msg);
}

function useLogFile(path: string) {
  const fd = openSync(path, "a");
  logSink = (line) => writeSync(fd, line + "\n");
}

function die(msg: string, code: number): never {
  log(`Error: ${msg}`);
  console.error(`Error: ${msg}`);
  console.log(`STATUS: aborted — ${msg.split("\n")[0]}`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Hard boundary. Path components are tokenized (camelCase / kebab-case /
// snake_case / directory separators all split) so "authMiddleware.ts",
// "user-auth/" and "auth.server.ts" all match while "author.ts" does not.
// Only the path RELATIVE TO ROOT is inspected, so a project that merely lives
// under a directory called "authly" is not refused wholesale.
// ---------------------------------------------------------------------------

const BANNED_TOKENS = new Set([
  "migration", "migrations",
  "rls",
  "auth", "authentication", "authorization",
  "entitlement", "entitlements",
]);
const BANNED_TOKEN_PAIRS: [string, string][] = [["security", "definer"]];
const SERVER_SUFFIX_RE = /\.server\.(ts|tsx|js|jsx)$/i;

function tokenize(path: string): string[] {
  return path
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[/\\._-]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function boundaryReason(root: string, absPath: string): string | null {
  const rel = relative(resolve(root), absPath);
  if (SERVER_SUFFIX_RE.test(rel)) return "matches the .server.* boundary";
  const tokens = new Set(tokenize(rel));
  for (const t of BANNED_TOKENS) {
    if (tokens.has(t)) return `contains hard-boundary keyword "${t}"`;
  }
  for (const [a, b] of BANNED_TOKEN_PAIRS) {
    if (tokens.has(a) && tokens.has(b)) return `contains hard-boundary keywords "${a} ${b}"`;
  }
  return null;
}

/** Resolves relPath under root; throws if it would escape root. */
function resolveWithinRoot(root: string, relPath: string): string {
  const abs = resolve(root, relPath.replace(/^\.\/+/, ""));
  const rootAbs = resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
    throw new Error(`path "${relPath}" escapes the project root`);
  }
  return abs;
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

type AssertSpec =
  | string
  | { text: string; file?: string; absent?: boolean }
  | { regex: string; file?: string; absent?: boolean };

interface Assertion {
  kind: "text" | "regex";
  value: string;
  file?: string;
  absent: boolean;
}

interface PassSpec {
  task: string;
  scope: string[];
  context?: string[];
  eslintScope?: string[];
  /** Custom gate: argv arrays run in root, all must exit 0. Replaces tsc+eslint. */
  verify?: string[][];
  assert?: AssertSpec[];
  maxTokens?: number;
  allowShrink?: boolean;
  /** SEARCH/REPLACE edit blocks instead of whole files, for files too big to re-emit. */
  patch?: boolean;
  review?: boolean;
  name?: string;
}

interface TaskSpec extends Partial<PassSpec> {
  root?: string;
  model?: string;
  passes?: PassSpec[];
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

const PASS_KEYS = ["name", "task", "scope", "context", "assert", "verify", "eslintScope", "maxTokens", "allowShrink", "patch", "review"];
const PASS_DEFAULT_KEYS = ["verify", "eslintScope", "maxTokens", "allowShrink", "patch", "review"];
const ASK_KEYS = ["ask", "root", "model", "readBudget", "maxTurns", "maxReadChars", "maxFileBytes", "maxTokens", "toolTurnTokens", "presencePenalty"];

/**
 * A misspelt key must not pass in silence: "asserts" for "assert" gives a green
 * pass with no contract checks at all.
 */
function rejectUnknownKeys(obj: object, allowed: string[], where: string): void {
  const stem = (k: string) => k.toLowerCase().replace(/[^a-z]/g, "").replace(/s$/, "");
  for (const k of Object.keys(obj)) {
    if (allowed.includes(k)) continue;
    const near = allowed.find((a) => stem(a) === stem(k));
    die(`${where}: unknown key "${k}"${near ? `. Did you mean "${near}"?` : "."} Allowed keys: ${allowed.join(", ")}`, 4);
  }
}

function normalizeAssert(a: AssertSpec, where: string): Assertion {
  if (typeof a === "string") {
    if (!a.trim()) die(`${where}: an assertion string is empty`, 4);
    return { kind: "text", value: a, absent: false };
  }
  if (!a || typeof a !== "object") die(`${where}: assertion must be a string or an object`, 4);
  const o = a as { text?: unknown; regex?: unknown; file?: unknown; absent?: unknown; pattern?: unknown };
  if (o.pattern !== undefined) {
    die(`${where}: "pattern" is no longer accepted — use {"regex": ...} for a regex or {"text": ...} for literal text`, 4);
  }
  const hasText = typeof o.text === "string" && o.text.trim() !== "";
  const hasRegex = typeof o.regex === "string" && o.regex.trim() !== "";
  if (hasText === hasRegex) die(`${where}: assertion object needs exactly one of "text" or "regex"`, 4);
  if (o.file !== undefined && typeof o.file !== "string") die(`${where}: assertion "file" must be a string`, 4);
  if (o.absent !== undefined && typeof o.absent !== "boolean") die(`${where}: assertion "absent" must be a boolean`, 4);
  if (hasRegex) {
    try {
      new RegExp(o.regex as string, "m");
    } catch (e) {
      die(`${where}: /${o.regex}/ is not a valid regex: ${(e as Error).message}`, 4);
    }
  }
  return {
    kind: hasText ? "text" : "regex",
    value: (hasText ? o.text : o.regex) as string,
    file: o.file as string | undefined,
    absent: o.absent === true,
  };
}

function validatePass(p: Partial<PassSpec>, where: string, extraKeys: string[] = []): PassSpec {
  rejectUnknownKeys(p, [...PASS_KEYS, ...extraKeys], where);
  if (typeof p.task !== "string" || !p.task.trim()) die(`${where} needs a non-empty "task" string`, 4);
  if (!isStringArray(p.scope) || p.scope.length === 0 || p.scope.some((s) => !s.trim())) {
    die(`${where} needs a non-empty "scope" array of file paths`, 4);
  }
  if (p.context !== undefined && !isStringArray(p.context)) die(`${where} "context" must be an array of file paths`, 4);
  if (p.eslintScope !== undefined && !isStringArray(p.eslintScope)) die(`${where} "eslintScope" must be an array of file paths`, 4);
  if (p.verify !== undefined) {
    const ok = Array.isArray(p.verify) && p.verify.length > 0 &&
      p.verify.every((c) => isStringArray(c) && c.length > 0);
    if (!ok) die(`${where} "verify" must be a non-empty array of argv arrays, e.g. [["/usr/bin/node","--check","x.js"]]`, 4);
  }
  if (p.assert !== undefined) {
    if (!Array.isArray(p.assert)) die(`${where} "assert" must be an array`, 4);
    const scope = dedupe(p.scope);
    p.assert.forEach((a, i) => {
      const n = normalizeAssert(a, `${where} assert[${i}]`);
      // The model can only write scope files, so a check on any other file can never
      // be fixed: a typo here would burn every retry on correct code.
      if (n.file !== undefined && !scope.includes(n.file.replace(/^\.\/+/, ""))) {
        die(`${where} assert[${i}]: "file" is "${n.file}", which is not in this pass's "scope" (${scope.join(", ")})`, 4);
      }
    });
  }
  if (p.maxTokens !== undefined && (typeof p.maxTokens !== "number" || p.maxTokens <= 0)) {
    die(`${where} "maxTokens" must be a positive number`, 4);
  }
  if (p.allowShrink !== undefined && typeof p.allowShrink !== "boolean") die(`${where} "allowShrink" must be a boolean`, 4);
  if (p.patch !== undefined && typeof p.patch !== "boolean") die(`${where} "patch" must be a boolean`, 4);
  if (p.review !== undefined && typeof p.review !== "boolean") die(`${where} "review" must be a boolean`, 4);
  if (p.name !== undefined && typeof p.name !== "string") die(`${where} "name" must be a string`, 4);
  return p as PassSpec;
}

function loadSpec(path: string): TaskSpec {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    die(`cannot read spec "${path}": ${(e as Error).message}`, 4);
  }
  try {
    return JSON.parse(raw!) as TaskSpec;
  } catch (e) {
    die(`spec "${path}" is not valid JSON: ${(e as Error).message}`, 4);
  }
}

/** Flattens a spec into an ordered pass list, applying top-level defaults. */
function expandPasses(spec: TaskSpec): PassSpec[] {
  if (spec.passes === undefined) return [validatePass(spec, "spec", ["root", "model"])];
  if (!Array.isArray(spec.passes) || spec.passes.length === 0) die(`"passes" must be a non-empty array`, 4);
  if (spec.task !== undefined || spec.scope !== undefined) {
    die(`spec has both "passes" and a top-level "task"/"scope" — use one or the other`, 4);
  }
  rejectUnknownKeys(spec, ["root", "model", "passes", ...PASS_DEFAULT_KEYS], "spec (top level, next to \"passes\")");
  return spec.passes.map((p, i) => validatePass({
    verify: spec.verify,
    eslintScope: spec.eslintScope,
    maxTokens: spec.maxTokens,
    allowShrink: spec.allowShrink,
    patch: spec.patch,
    review: spec.review,
    ...p,
  }, `passes[${i}]`));
}

// ---------------------------------------------------------------------------
// Model server client: any OpenAI-compatible /v1/chat/completions with streaming and tools
// ---------------------------------------------------------------------------

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  /** "stop" | "length" | "tool_calls" | ... — "length" means the max_tokens ceiling was hit. */
  finishReason: string | null;
  elapsedMs: number;
}

async function listModels(url: string): Promise<string[]> {
  const res = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { data?: { id: string }[] };
  return (data.data ?? []).map((m) => m.id);
}

/**
 * Streams deliberately: a cold model load or a long prefill can go minutes
 * without a content byte, and a non-streaming request would die on the HTTP
 * client's idle timeout. Streaming keeps bytes flowing.
 */
async function chat(
  messages: ChatMessage[],
  model: string,
  maxTokens: number,
  temperature: number,
  url: string,
  tools?: ToolDef[],
  sampling: Record<string, number> = {},
): Promise<ChatResult> {
  const started = Date.now();
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model, messages, max_tokens: maxTokens, temperature, stream: true, ...sampling,
      ...(tools && tools.length > 0 ? { tools } : {}),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`model server HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  if (!res.body) throw new Error("the model server returned no response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  const calls = new Map<number, ToolCall>();
  let finishReason: string | null = null;
  let lastTick = Date.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload) as {
          choices?: {
            delta?: {
              content?: string | null;
              tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
            };
            finish_reason?: string | null;
          }[];
        };
        const c = j.choices?.[0];
        if (c?.delta?.content) content += c.delta.content;
        for (const tc of c?.delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const cur = calls.get(idx) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.function.name += tc.function.name;
          if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
          calls.set(idx, cur);
        }
        if (c?.finish_reason) finishReason = c.finish_reason;
      } catch {
        // partial or keepalive line
      }
    }
    if (Date.now() - lastTick > 30_000) {
      lastTick = Date.now();
      log(`    ...streaming (${content.length} chars so far)`);
    }
  }
  const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => ({
    ...c, id: c.id || `call_${i}`,
  }));
  return { content, toolCalls, finishReason, elapsedMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Response protocol: <<<FILE path>>> ... <<<END>>>
// Lenient on purpose: the model slips (drops FILE, adds a bracket, lowercases
// END) and a strict regex would throw away a good file over a typo and then
// re-roll the same slip every retry. A path outside `scope` is rejected later.
// ---------------------------------------------------------------------------

const FILE_BLOCK_RE =
  /<{3,}[ \t]*(?!(?:END|SEARCH|REPLACE|EDIT)\b)(?:FILE[ \t]+)?([^\s>]+)[ \t]*>{3,}\r?\n([\s\S]*?)\r?\n?<{3,}[ \t]*END[^>\n]*>{3,}/gi;

interface ParsedFile {
  path: string;
  content: string;
}

/** Strips an accidental markdown fence around a block body. */
function stripFence(content: string): string {
  const lines = content.split("\n");
  if (lines.length >= 2 && /^```/.test(lines[0]) && /^```\s*$/.test(lines[lines.length - 1])) {
    return lines.slice(1, -1).join("\n");
  }
  return content;
}

function parseFileBlocks(response: string): ParsedFile[] {
  const out: ParsedFile[] = [];
  for (const m of response.matchAll(FILE_BLOCK_RE)) {
    out.push({ path: m[1].trim().replace(/^\.\/+/, ""), content: stripFence(m[2]) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Patch protocol, for files too big to re-emit whole:
//   <<<EDIT path>>>  <<<SEARCH>>> old lines  <<<REPLACE>>> new lines  <<<END>>>
// Every attempt is applied to the pass's ORIGINAL file, so the model always
// sends its full set of edits and a failed attempt leaves nothing half-applied.
// SEARCH matches exactly first, then line by line ignoring trailing whitespace,
// then ignoring indentation (REPLACE is re-indented to fit). It must match once.
// ---------------------------------------------------------------------------

const EDIT_BLOCK_RE = /<{3,}[ \t]*EDIT[ \t]+([^\s>]+)[ \t]*>{3,}[ \t]*\r?\n([\s\S]*?)<{3,}[ \t]*END[^>\n]*>{3,}/gi;
const EDIT_MARKER_RE = /<{3,}[ \t]*(SEARCH|REPLACE)[ \t]*>{3,}[ \t]*(?:\r?\n)?/i;

interface ParsedEdit {
  path: string;
  search: string;
  replace: string;
}

interface PatchResponse {
  edits: ParsedEdit[];
  malformed: string[];
  /** Whole-file blocks outside the EDIT blocks (new files). */
  files: ParsedFile[];
}

function parsePatchResponse(response: string): PatchResponse {
  const edits: ParsedEdit[] = [];
  const malformed: string[] = [];
  let n = 0;
  const rest = response.replace(EDIT_BLOCK_RE, (_all, rawPath: string, body: string) => {
    n++;
    const path = rawPath.trim().replace(/^\.\/+/, "");
    // split() with a capture group interleaves the marker names: [lead, "SEARCH", s, "REPLACE", r, ...]
    const parts = body.split(new RegExp(EDIT_MARKER_RE.source, "gi"));
    const pairs: ParsedEdit[] = [];
    let ok = parts[0].trim() === "" && parts.length >= 5 && (parts.length - 1) % 4 === 0;
    for (let i = 1; ok && i < parts.length; i += 4) {
      ok = parts[i].toUpperCase() === "SEARCH" && parts[i + 2].toUpperCase() === "REPLACE";
      const section = (s: string) => stripFence(s.replace(/\r?\n$/, ""));
      if (ok) pairs.push({ path, search: section(parts[i + 1]), replace: section(parts[i + 3]) });
    }
    if (ok) edits.push(...pairs);
    else malformed.push(`EDIT block ${n} (${path}) is malformed: it needs <<<SEARCH>>>, the old lines, <<<REPLACE>>>, the new lines, then <<<END>>>.`);
    return "";
  });
  return { edits, malformed, files: parseFileBlocks(rest) };
}

function lineOf(content: string, offset: number): number {
  return content.slice(0, offset).split("\n").length;
}

function leadingSpace(s: string): string {
  return /^\s*/.exec(s)![0];
}

/** Moves REPLACE to the file's indentation when SEARCH only matched with indentation ignored. */
function reindent(replace: string[], fileLine: string, searchLine: string): string[] {
  const fi = leadingSpace(fileLine);
  const si = leadingSpace(searchLine);
  if (fi === si) return replace;
  if (fi.endsWith(si)) {
    const add = fi.slice(0, fi.length - si.length);
    return replace.map((l) => (l.trim() ? add + l : l));
  }
  if (si.endsWith(fi)) {
    const cut = si.slice(0, si.length - fi.length);
    return replace.map((l) => (l.startsWith(cut) ? l.slice(cut.length) : l));
  }
  return replace;
}

function applyEdit(content: string, search: string, replace: string): { content: string } | { error: string } {
  if (search.trim() === "") return { error: "SEARCH is empty. It must quote the existing lines to change." };

  const first = content.indexOf(search);
  if (first !== -1) {
    const offsets = [first];
    for (let at = content.indexOf(search, first + 1); at !== -1 && offsets.length < 5; at = content.indexOf(search, at + 1)) offsets.push(at);
    if (offsets.length > 1) {
      return { error: `SEARCH matches ${offsets.length === 5 ? "5 or more" : offsets.length} places (lines ${offsets.map((o) => lineOf(content, o)).join(", ")}). Add neighbouring lines so it matches exactly one.` };
    }
    let end = first + search.length;
    // Deleting whole lines: take the line break too, so no blank line is left behind.
    if (replace === "" && content[end] === "\n" && (first === 0 || content[first - 1] === "\n")) end++;
    return { content: content.slice(0, first) + replace + content.slice(end) };
  }

  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const needle = search.split(/\r?\n/);
  while (needle.length > 1 && needle[0].trim() === "") needle.shift();
  while (needle.length > 1 && needle[needle.length - 1].trim() === "") needle.pop();
  const replaceLines = replace === "" ? [] : replace.split(/\r?\n/);
  const anchor = needle.findIndex((l) => l.trim() !== "");

  for (const [norm, fuzzyIndent] of [[(l: string) => l.trimEnd(), false], [(l: string) => l.trim(), true]] as const) {
    const have = lines.map(norm);
    const want = needle.map(norm);
    const hits: number[] = [];
    outer: for (let i = 0; i + want.length <= have.length; i++) {
      for (let j = 0; j < want.length; j++) if (have[i + j] !== want[j]) continue outer;
      hits.push(i);
    }
    if (hits.length > 1) {
      return { error: `SEARCH matches ${hits.length} places (lines ${hits.slice(0, 5).map((h) => h + 1).join(", ")}). Add neighbouring lines so it matches exactly one.` };
    }
    if (hits.length === 1) {
      const at = hits[0];
      const body = fuzzyIndent ? reindent(replaceLines, lines[at + anchor], needle[anchor]) : replaceLines;
      lines.splice(at, needle.length, ...body);
      return { content: lines.join(eol) };
    }
  }

  const probe = needle[anchor].trim();
  const near = lines.flatMap((l, i) => (l.trim() === probe ? [i] : [])).slice(0, 3);
  if (near.length === 0) {
    return { error: `SEARCH was not found. No line in the file matches its first line:\n    ${probe}\n  Copy SEARCH exactly from the current file.` };
  }
  const windows = near.map((i) => {
    const from = Math.max(0, i - 1);
    const to = Math.min(lines.length, i + Math.min(needle.length, 10) + 1);
    return lines.slice(from, to).map((l, k) => `${String(from + k + 1).padStart(6)}| ${l}`).join("\n");
  });
  return {
    error: `SEARCH was not found. Its first line occurs, but the lines after it differ. The current file there:\n${windows.join("\n   ...\n")}\n  Copy SEARCH exactly from these lines.`,
  };
}

interface PatchOutcome {
  files: ParsedFile[];
  errors: string[];
  rejected: string[];
}

/** Applies every edit to the original files. Any error means nothing may be written. */
function applyPatch(parsed: PatchResponse, scope: string[], baseline: Map<string, string | null>): PatchOutcome {
  const out: PatchOutcome = { files: [], errors: [...parsed.malformed], rejected: [] };
  const working = new Map<string, string>();
  parsed.edits.forEach((e, i) => {
    if (!scope.includes(e.path)) { out.rejected.push(e.path); return; }
    const current = working.get(e.path) ?? baseline.get(e.path);
    if (current == null) {
      out.errors.push(`EDIT ${i + 1} on ${e.path}: the file does not exist yet. Create it with a <<<FILE ${e.path}>>> block.`);
      return;
    }
    const r = applyEdit(current, e.search, e.replace);
    if ("error" in r) out.errors.push(`EDIT ${i + 1} on ${e.path}: ${r.error}`);
    else working.set(e.path, r.content);
  });
  for (const f of parsed.files) {
    if (scope.includes(f.path) && baseline.get(f.path) != null) {
      out.errors.push(`${f.path} already exists, so change it with EDIT blocks. Do not re-emit the whole file.`);
    } else {
      out.files.push(f);
    }
  }
  for (const [path, content] of working) out.files.push({ path, content });
  return out;
}

// ---------------------------------------------------------------------------
// Commands and the gate
// ---------------------------------------------------------------------------

interface CmdResult {
  ok: boolean;
  output: string;
}

/**
 * Never throws. A program that cannot start (a wrong path in `verify`) and one that
 * hangs (a test runner in watch mode, an endless loop in generated code) both come
 * back as a failed command, so the run still ends with a report.
 */
async function runCommand(cmd: string[], cwd: string, timeoutMs = 0): Promise<CmdResult> {
  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
  try {
    proc = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    return { ok: false, output: `cannot run "${cmd[0]}": ${(e as Error).message}` };
  }
  const finished = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timeoutMs <= 0) {
    const [stdout, stderr, code] = await finished;
    return { ok: code === 0, output: (stdout + stderr).trim() };
  }
  // Raced, not awaited after the kill: a grandchild can hold the pipes open.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((r) => { timer = setTimeout(() => r(null), timeoutMs); });
  const done = await Promise.race([finished, timedOut]);
  clearTimeout(timer);
  if (done === null) {
    proc.kill("SIGKILL");
    return { ok: false, output: `timed out after ${Math.round(timeoutMs / 1000)}s and was killed. A gate must end on its own: no watch mode, no prompt for input, no endless loop. Raise --gate-timeout only when the gate is slow but correct.` };
  }
  const [stdout, stderr, code] = done;
  return { ok: code === 0, output: (stdout + stderr).trim() };
}

function hasEslintConfig(root: string): boolean {
  const candidates = [
    "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts",
    ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml",
  ];
  if (candidates.some((f) => existsSync(join(root, f)))) return true;
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      if (JSON.parse(readFileSync(pkgPath, "utf8")).eslintConfig) return true;
    } catch {
      // fall through
    }
  }
  return false;
}

/** Runs the gate and returns the failing sections (empty means green). */
async function runGate(root: string, pass: PassSpec, eslintTargets: string[], quiet: boolean, timeoutMs: number): Promise<string[]> {
  const failures: string[] = [];
  if (pass.verify) {
    for (const cmd of pass.verify) {
      if (!quiet) log(`  running ${cmd.join(" ")}`);
      const r = await runCommand(cmd, root, timeoutMs);
      if (!r.ok) failures.push(`--- ${cmd.join(" ")} ---\n${truncate(r.output, MAX_ERROR_CHARS)}`);
    }
    return failures;
  }
  if (!quiet) log("  running tsc --noEmit");
  const tsc = await runCommand(["bunx", "tsc", "--noEmit"], root, timeoutMs);
  const existing = eslintTargets.filter((p) => existsSync(resolveWithinRoot(root, p)));
  if (!quiet) log(`  running eslint on ${existing.length} file(s)`);
  const eslint = existing.length > 0
    ? await runCommand(["bunx", "eslint", "--no-error-on-unmatched-pattern", ...existing], root, timeoutMs)
    : { ok: true, output: "" };
  if (!tsc.ok) failures.push(`--- tsc --noEmit ---\n${truncate(tsc.output, MAX_ERROR_CHARS)}`);
  if (!eslint.ok) failures.push(`--- eslint ---\n${truncate(eslint.output, MAX_ERROR_CHARS)}`);
  return failures;
}

function gateLabel(pass: PassSpec): string {
  if (!pass.verify) return "tsc+eslint";
  return [...new Set(pass.verify.map((c) => c[0].split("/").pop() ?? c[0]))].join("+");
}

// ---------------------------------------------------------------------------
// Contract assertions. Literal text is matched with all whitespace removed and
// trailing commas before ) ] } dropped, so a signature the model wrapped onto
// two lines still matches while a wrong name or type still fails. A regex is
// tried strictly first, then with the same whitespace tolerance.
// ---------------------------------------------------------------------------

interface AssertOutcome {
  total: number;
  matched: number;
  failures: string[];
}

function squash(s: string): string {
  return s.replace(/\s+/g, "").replace(/,(?=[)\]}])/g, "");
}

function assertionHits(a: Assertion, body: string): boolean {
  if (a.kind === "text") return squash(body).includes(squash(a.value));
  if (new RegExp(a.value, "m").test(body)) return true;
  try {
    return new RegExp(a.value.replace(/ /g, ""), "m").test(squash(body));
  } catch {
    return false;
  }
}

function describeAssertion(a: Assertion): string {
  const what = a.kind === "text" ? `\`${a.value}\`` : `/${a.value}/`;
  const where = a.file ? ` in ${a.file}` : "";
  if (a.absent) return `must NOT contain${where}: ${what}`;
  return a.kind === "text" ? `must contain verbatim${where}: ${what}` : `must match regex${where}: ${what}`;
}

async function checkAsserts(root: string, asserts: Assertion[], scope: string[]): Promise<AssertOutcome> {
  if (asserts.length === 0) return { total: 0, matched: 0, failures: [] };
  const cache = new Map<string, string>();
  const read = async (rel: string): Promise<string> => {
    if (!cache.has(rel)) {
      const abs = resolveWithinRoot(root, rel);
      cache.set(rel, existsSync(abs) ? await readFile(abs, "utf8") : "");
    }
    return cache.get(rel)!;
  };

  const failures: string[] = [];
  let matched = 0;
  for (const a of asserts) {
    const targets = a.file ? [a.file] : scope;
    let hitIn = "";
    for (const t of targets) {
      if (assertionHits(a, await read(t))) { hitIn = t; break; }
    }
    const hit = hitIn !== "";
    if (a.absent ? !hit : hit) {
      matched++;
    } else if (a.absent) {
      failures.push(`FORBIDDEN: ${hitIn} contains ${a.kind === "text" ? "the text" : "text matching the regex"} ${a.kind === "text" ? `\`${a.value}\`` : `/${a.value}/`}. Remove every occurrence.`);
    } else if (a.kind === "text") {
      failures.push(`REQUIRED: ${targets.join(" or ")} must contain this text verbatim and does not:\n  ${a.value}`);
    } else {
      failures.push(`REQUIRED: ${targets.join(" or ")} must contain text matching the regex /${a.value}/ and does not.`);
    }
  }
  return { total: asserts.length, matched, failures };
}

// ---------------------------------------------------------------------------
// Self-review: a fresh conversation judges the file against the contract.
// ---------------------------------------------------------------------------

const REVIEW_SYSTEM = [
  "You are a strict senior code reviewer. Judge ONLY whether the code meets the task contract.",
  "",
  "Reply with exactly the single word OK when every requirement is met and you see no real defect.",
  "Otherwise reply with a numbered list of at most 5 concrete defects. Each item names the file and",
  "line, says what is wrong, and says what the contract requires instead.",
  "",
  "Report only real defects: a contract requirement not met, an edge case the contract names that is",
  "not handled, wrong arithmetic or index math, a name or signature that differs from the contract,",
  "or a change the task did not ask for. Ignore style, formatting, naming taste, comments, and",
  "hypothetical improvements. Never rewrite the code. Never reply with anything but OK or the list.",
].join("\n");

function numbered(content: string): string {
  return content.replace(/\n$/, "").split("\n").map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join("\n");
}

/**
 * Returns null when the reviewer is satisfied, else its findings. `sections` are
 * the numbered files, or in patch mode unified diffs, so a huge file is not re-sent.
 */
async function reviewFiles(
  task: string,
  checks: string[],
  sections: string[],
  opts: RunOptions,
): Promise<string | null> {
  const user = [
    `Task contract:\n${task}`,
    checks.length > 0 ? `Contract checks (already verified mechanically):\n${checks.map((c) => `- ${c}`).join("\n")}` : "",
    ...sections,
  ].filter(Boolean).join("\n\n");
  const messages: ChatMessage[] = [{ role: "system", content: REVIEW_SYSTEM }, { role: "user", content: user }];
  if (transcriptTokens(messages) + REVIEW_MAX_TOKENS > opts.ctx) {
    throw new Error(`review prompt ~${transcriptTokens(messages)} tok does not fit the ${opts.ctx} tok context`);
  }
  const r = await chat(messages, opts.model, REVIEW_MAX_TOKENS, REVIEW_TEMPERATURE, opts.url);
  const text = r.content.trim();
  log(`  review: ${Math.round(r.elapsedMs / 1000)}s, ${text.length} chars`);
  if (text === "" || /^(ok\b|no (real )?(defects?|issues?|problems?)|looks good|lgtm)/i.test(text)) return null;
  return truncate(text, MAX_REVIEW_CHARS);
}

// ---------------------------------------------------------------------------
// Diff, via the system `diff` binary
// ---------------------------------------------------------------------------

async function unifiedDiff(workDir: string, relPath: string, before: string | null, after: string, context = 3): Promise<string> {
  const oldFile = before === null ? "/dev/null" : join(workDir, "old");
  const newFile = join(workDir, "new");
  if (before !== null) await writeFile(oldFile, before);
  await writeFile(newFile, after);
  const { output } = await runCommand([
    "diff", `-U${context}`,
    "--label", before === null ? "/dev/null" : `a/${relPath}`,
    "--label", `b/${relPath}`,
    oldFile, newFile,
  ], workDir);
  return output;
}

function diffCounts(d: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of d.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `\n...[truncated, ${s.length - max} more chars]`;
}

function countLines(s: string): number {
  return s === "" ? 0 : s.replace(/\n$/, "").split("\n").length;
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

function transcriptTokens(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + estimateTokens((m.content ?? "") + (m.tool_calls ? JSON.stringify(m.tool_calls) : "")), 0);
}

/**
 * Makes a write-mode transcript fit before a call: [system, task, (reply, feedback)*].
 * Every reply re-sends the complete change, so the oldest exchanges are safe to drop.
 * Returns false when even the shortest transcript does not fit.
 */
function fitTranscript(messages: ChatMessage[], budget: number, ctx: number): boolean {
  let dropped = 0;
  while (transcriptTokens(messages) + budget > ctx && messages.length > 4) {
    messages.splice(2, 2);
    dropped++;
  }
  if (dropped > 0) log(`  dropped the ${dropped} oldest attempt(s) from the transcript to fit the ${ctx} tok context`);
  return transcriptTokens(messages) + budget <= ctx;
}

function dedupe(paths: string[]): string[] {
  return [...new Set(paths.map((s) => s.replace(/^\.\/+/, "")))];
}

// ---------------------------------------------------------------------------
// One pass
// ---------------------------------------------------------------------------

interface FileReport {
  path: string;
  lines: number;
  isNew: boolean;
  added: number;
  removed: number;
}

interface PassResult {
  name: string;
  green: boolean;
  attempts: number;
  files: FileReport[];
  asserts: AssertOutcome;
  gate: string;
  review: string;
  reviewNotes: string;
  elapsedMs: number;
  lastErrors: string;
  note: string;
}

interface RunOptions {
  root: string;
  url: string;
  model: string;
  maxRetries: number;
  maxTokens: number;
  ctx: number;
  review: boolean;
  allowDirtyGate: boolean;
  gateTimeoutMs: number;
  workDir: string;
}

interface ApplyOutcome {
  accepted: string[];
  rejected: string[];
  shrunk: string[];
  boundary: string | null;
}

/** Writes the in-scope files from a model response to disk, with the guards. */
async function applyResponse(
  files: ParsedFile[],
  scope: string[],
  baseline: Map<string, string | null>,
  allowShrink: boolean,
  root: string,
): Promise<ApplyOutcome> {
  const out: ApplyOutcome = { accepted: [], rejected: [], shrunk: [], boundary: null };
  for (const f of files) {
    if (!scope.includes(f.path)) { out.rejected.push(f.path); continue; }
    let abs: string;
    try {
      abs = resolveWithinRoot(root, f.path);
    } catch {
      out.rejected.push(f.path);
      continue;
    }
    const reason = boundaryReason(root, abs);
    if (reason) { out.boundary = `${f.path} (${reason})`; return out; }

    const content = f.content.endsWith("\n") ? f.content : f.content + "\n";
    const before = baseline.get(f.path);
    if (!allowShrink && before) {
      const beforeLines = countLines(before);
      const afterLines = countLines(content);
      if (beforeLines >= SHRINK_MIN_LINES && afterLines < beforeLines * SHRINK_FLOOR) {
        out.shrunk.push(`${f.path}: ${beforeLines} lines -> ${afterLines} lines`);
        continue;
      }
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
    out.accepted.push(f.path);
  }
  return out;
}

async function readScope(root: string, scope: string[]): Promise<ParsedFile[]> {
  const out: ParsedFile[] = [];
  for (const p of scope) {
    const abs = resolveWithinRoot(root, p);
    if (existsSync(abs)) out.push({ path: p, content: await readFile(abs, "utf8") });
  }
  return out;
}

async function runPass(
  pass: PassSpec,
  opts: RunOptions,
  baselineAll: Map<string, string | null>,
  skipPreflight: boolean,
): Promise<PassResult> {
  const { root } = opts;
  const started = Date.now();
  const scope = dedupe(pass.scope);
  const context = dedupe(pass.context ?? []);
  const eslintTargets = dedupe(pass.eslintScope ?? pass.scope);
  const asserts = (pass.assert ?? []).map((a, i) => normalizeAssert(a, `assert[${i}]`));
  const name = pass.name ?? scope[0];
  const gate = gateLabel(pass);
  const reviewOn = opts.review && pass.review !== false;

  const result: PassResult = {
    name, green: false, attempts: 0, files: [],
    asserts: { total: asserts.length, matched: 0, failures: [] },
    gate, review: reviewOn ? "skipped" : "off", reviewNotes: "",
    elapsedMs: 0, lastErrors: "", note: "",
  };
  const finish = (): PassResult => {
    result.elapsedMs = Date.now() - started;
    return result;
  };

  // --- Boundary check on the declared scope/context, before any network call.
  const violations: string[] = [];
  for (const p of [...scope, ...context]) {
    try {
      const reason = boundaryReason(root, resolveWithinRoot(root, p));
      if (reason) violations.push(`  ${p} — ${reason}`);
    } catch (e) {
      violations.push(`  ${p} — ${(e as Error).message}`);
    }
  }
  if (violations.length > 0) {
    log(`[${name}] refusing: scope/context touches a hard-boundary path\n${violations.join("\n")}`);
    result.note = "boundary violation";
    result.lastErrors = violations.join("\n");
    return finish();
  }

  // --- A context file that is not there is a typo, and the model would then guess
  //     the names the contract told it to copy. Checked per pass, not at load, because
  //     a later pass may list an earlier pass's output.
  const missing = context.filter((p) => {
    const abs = resolveWithinRoot(root, p);
    return !existsSync(abs) || !statSync(abs).isFile();
  });
  if (missing.length > 0) {
    log(`[${name}] refusing: context file(s) not found under ${root}: ${missing.join(", ")}`);
    result.note = "context file not found";
    result.lastErrors = `Not a file under ${root}:\n${missing.map((p) => `  ${p}`).join("\n")}\nFix the path in "context", or remove it.`;
    return finish();
  }

  // --- Snapshot the scope files, for the shrink guard and the diff.
  const baseline = new Map<string, string | null>();
  for (const p of scope) {
    const abs = resolveWithinRoot(root, p);
    const body = existsSync(abs) ? await readFile(abs, "utf8") : null;
    baseline.set(p, body);
    if (!baselineAll.has(p)) baselineAll.set(p, body);
  }

  // --- Gate pre-flight on the UNCHANGED tree.
  if (skipPreflight) {
    log(`[${name}] gate pre-flight skipped (previous pass left the tree green)`);
  } else {
    const preFailures = await runGate(root, pass, eslintTargets, true, opts.gateTimeoutMs);
    log(`[${name}] gate pre-flight (${gate}): ${preFailures.length === 0 ? "clean" : "FAILING"}`);
    if (preFailures.length > 0) {
      if (!opts.allowDirtyGate) {
        log(
          `[${name}] refusing: the gate already fails on the unchanged tree, so every retry would be\n` +
          `spent on an error the model cannot fix. Fix the gate, or pass --allow-dirty-gate when the\n` +
          `failure is expected (this pass creates a file the project already imports).\n\n` +
          truncate(preFailures.join("\n\n"), MAX_ERROR_CHARS),
        );
        result.note = "gate already failing before any change";
        result.lastErrors = truncate(preFailures.join("\n\n"), MAX_ERROR_CHARS);
        return finish();
      }
      log(`  --allow-dirty-gate: continuing anyway`);
    }
  }

  // --- Prompts.
  const patch = pass.patch === true;
  const formatRules = patch
    ? [
      "These files are large, so never re-emit an existing file whole. Respond ONLY with edit blocks,",
      "one per change, in exactly this format:",
      "",
      "<<<EDIT relative/path/to/file>>>",
      "<<<SEARCH>>>",
      "the existing lines to change, copied exactly from the current file",
      "<<<REPLACE>>>",
      "the lines that take their place",
      "<<<END>>>",
      "",
      "Rules:",
      `- Only these files may be edited: ${scope.join(", ")}`,
      "- Never emit any other file path, even a related one.",
      "- SEARCH is copied character for character from the current file, indentation included, and must",
      "  match exactly ONE place. When those lines also occur elsewhere, add a neighbouring unchanged line.",
      "- Keep each SEARCH short: the lines that change plus at most 2 unchanged lines around them.",
      "- Blocks apply in order. A later block sees the file as the earlier blocks left it.",
      "- To delete lines, leave REPLACE empty. To insert, SEARCH for the line just before the insertion",
      "  point and repeat that line at the top of REPLACE, followed by the new lines.",
      "- To create a scope file that does not exist yet, use <<<FILE relative/path>>>, its complete",
      "  contents, and <<<END>>> instead.",
      "- No text outside the blocks: no explanations, no markdown fences.",
    ]
    : [
      "Respond ONLY with one block per file you create or modify, in exactly this format:",
      "",
      "<<<FILE relative/path/to/file.ts>>>",
      "...complete file contents...",
      "<<<END>>>",
      "",
      "Rules:",
      `- Only these files may be created or edited: ${scope.join(", ")}`,
      "- Never emit any other file path, even a related one.",
      "- Emit the COMPLETE contents of each file you touch, never a diff or a partial snippet.",
      "- When editing an existing file, keep every part you were not asked to change, byte for byte.",
      "- If a scope file needs no change, omit its block entirely.",
      "- No text outside the blocks: no explanations, no markdown fences.",
    ];
  const systemPrompt = [
    "You are a senior engineer making one scoped code change. Follow the task contract exactly:",
    "implement everything it asks for, add nothing it does not ask for, and match every name and",
    "signature it gives character for character.",
    "",
    ...formatRules,
  ].join("\n");

  const checks = asserts.map(describeAssertion);
  const contextSections: string[] = [];
  for (const p of context) {
    contextSections.push(`--- Read-only context: ${p} ---\n${await readFile(resolveWithinRoot(root, p), "utf8")}`);
  }
  const scopeSections = scope.map((p) => {
    const existing = baseline.get(p);
    if (existing == null) return `--- ${p} does not exist yet (create it) ---`;
    return `--- Current contents of ${p} (${patch ? "change it with EDIT blocks" : "edit this"}) ---\n${existing}`;
  });
  const userPrompt = [
    `Task:\n${pass.task}`,
    checks.length > 0 ? `Contract checks (run automatically on your output):\n${checks.map((c) => `- ${c}`).join("\n")}` : "",
    ...contextSections,
    ...scopeSections,
  ].filter(Boolean).join("\n\n");

  // --- Prompt-size pre-flight. Prefill is paid before the first output token.
  let maxTokens = pass.maxTokens ?? opts.maxTokens;
  const promptTokens = estimateTokens(systemPrompt + userPrompt);
  log(`  prompt ~${promptTokens} tok (~${Math.round(promptTokens / PREFILL_TOK_PER_SEC)}s prefill), budget ${maxTokens} tok`);
  if (promptTokens + maxTokens > opts.ctx) {
    log(`[${name}] refusing: prompt ~${promptTokens} tok + budget ${maxTokens} tok exceeds the ${opts.ctx} tok context ceiling. Trim "context" or lower the budget.`);
    result.note = "prompt exceeds context ceiling";
    return finish();
  }

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
  const totalAttempts = 1 + opts.maxRetries;
  const touched = new Set<string>();
  let budgetBumps = 0;
  const reemit = patch
    ? `Re-emit the COMPLETE set of EDIT blocks: every change the task needs, not only the fixes. They are applied to the ORIGINAL file shown in the first message, not to your earlier attempt. Only touch: ${scope.join(", ")}.`
    : `Re-emit the COMPLETE corrected contents of every file that needs to change, using the same <<<FILE path>>> / <<<END>>> format. Only touch: ${scope.join(", ")}.`;
  /** A reply as full file contents to write, or as errors to feed back. */
  const extract = (text: string): PatchOutcome =>
    patch ? applyPatch(parsePatchResponse(text), scope, baseline) : { files: parseFileBlocks(text), errors: [], rejected: [] };

  // --- Generate / gate / retry.
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    result.attempts = attempt;
    if (!fitTranscript(messages, maxTokens, opts.ctx)) {
      result.note = "prompt exceeds context ceiling";
      result.lastErrors = `prompt ~${transcriptTokens(messages)} tok + budget ${maxTokens} tok does not fit the ${opts.ctx} tok context, even with the earlier attempts dropped`;
      log(`[${name}] refusing: ${result.lastErrors}`);
      break;
    }
    log(`[${name}] attempt ${attempt}/${totalAttempts}: requesting ${opts.model} (budget ${maxTokens})`);
    let response: ChatResult;
    try {
      response = await chat(messages, opts.model, maxTokens, GEN_TEMPERATURE, opts.url);
    } catch (e) {
      log(`  model server request failed: ${(e as Error).message}`);
      result.note = "model server request failed";
      result.lastErrors = (e as Error).message;
      break;
    }
    const genTokens = estimateTokens(response.content);
    const tps = response.elapsedMs > 0 ? Math.round((genTokens / response.elapsedMs) * 1000) : 0;
    log(`  ${Math.round(response.elapsedMs / 1000)}s, ~${genTokens} tok out (~${tps} tok/s), finish=${response.finishReason ?? "?"}`);

    if (response.finishReason === "length") {
      // A truncated reply is not kept in the transcript: it would inflate the
      // prompt and teach the model that half a file is acceptable. A budget set
      // too low is the caller's mistake, so the bump does not cost a retry.
      const room = opts.ctx - transcriptTokens(messages);
      const grown = Math.min(maxTokens * TRUNCATION_GROWTH, MAX_TOKEN_CEILING, room);
      if (grown <= maxTokens || budgetBumps >= MAX_BUDGET_BUMPS) {
        result.note = `still truncated at ${maxTokens} tokens after ${budgetBumps} budget bump(s) — split the work into smaller passes${patch ? "" : ", or use patch mode"}`;
        result.lastErrors = result.note;
        break;
      }
      budgetBumps++;
      log(`  hit the ${maxTokens} token ceiling; raising budget to ${grown} (bump ${budgetBumps}/${MAX_BUDGET_BUMPS}, not a retry)`);
      maxTokens = grown;
      attempt--;
      continue;
    }

    messages.push({ role: "assistant", content: response.content });
    const extracted = extract(response.content);
    if (extracted.files.length === 0 && extracted.errors.length === 0 && extracted.rejected.length === 0) {
      const excerpt = response.content.trim().replace(/\s+/g, " ").slice(0, 400);
      log(`  no ${patch ? "<<<EDIT ...>>>" : "<<<FILE ...>>>"} blocks in the response (${response.content.length} chars); it began: ${excerpt || "(empty)"}`);
      messages.push({
        role: "user",
        content: patch
          ? `Your response contained no usable edit block. Re-emit it with the markers written EXACTLY like this, ` +
            `each with exactly three angle brackets:\n\n<<<EDIT ${scope[0]}>>>\n<<<SEARCH>>>\n...existing lines...\n<<<REPLACE>>>\n...new lines...\n<<<END>>>`
          : `Your response contained no usable file block. Re-emit it with the markers written EXACTLY like this, ` +
            `including the word FILE and exactly three angle brackets:\n\n` +
            scope.map((p) => `<<<FILE ${p}>>>\n...complete contents of ${p}...\n<<<END>>>`).join("\n\n"),
      });
      continue;
    }
    if (extracted.errors.length > 0) {
      result.lastErrors = `--- edits not applied ---\n${extracted.errors.join("\n")}`;
      log(`  ${extracted.errors.length} edit error(s); nothing was written`);
      messages.push({ role: "user", content: `None of your edits were applied, because:\n\n${extracted.errors.join("\n\n")}\n\nFix these. ${reemit}` });
      continue;
    }

    const applied = await applyResponse(extracted.files, scope, baseline, pass.allowShrink === true, root);
    applied.rejected.push(...extracted.rejected);
    if (applied.boundary) {
      log(`[${name}] refusing: model returned a hard-boundary path ${applied.boundary}`);
      result.note = "model returned a hard-boundary path";
      return finish();
    }
    if (applied.rejected.length > 0) log(`  ignored out-of-scope files: ${applied.rejected.join(", ")}`);
    if (applied.shrunk.length > 0) {
      log(`  rejected as truncated re-emit: ${applied.shrunk.join("; ")}`);
      messages.push({
        role: "user",
        content: patch
          ? `Your edits removed most of the file:\n${applied.shrunk.join("\n")}\n\nChange only what the task asks for. ${reemit}`
          : `You dropped most of the file:\n${applied.shrunk.join("\n")}\n\n` +
            `Re-emit the COMPLETE file. Keep every existing declaration, import, comment and export that ` +
            `the task did not ask you to change, and apply only the requested change.`,
      });
      continue;
    }
    if (applied.accepted.length === 0) {
      messages.push({
        role: "user",
        content: `None of the files you returned (${applied.rejected.join(", ")}) are in the allowed scope: ${scope.join(", ")}. ${reemit}`,
      });
      continue;
    }
    for (const p of applied.accepted) touched.add(p);
    log(`  wrote: ${applied.accepted.join(", ")}`);

    const failures = await runGate(root, pass, eslintTargets, false, opts.gateTimeoutMs);
    const outcome = await checkAsserts(root, asserts, scope);
    result.asserts = outcome;
    if (outcome.total > 0) {
      log(`  contract checks: ${outcome.matched}/${outcome.total}`);
      if (outcome.failures.length > 0) failures.push(`--- contract checks ---\n${outcome.failures.join("\n")}`);
    }
    if (failures.length === 0) {
      result.green = true;
      break;
    }
    result.lastErrors = failures.join("\n\n");
    // Name the failing command and its first lines here too: a log that says only
    // "failed verification" cannot tell a gate error from a contract miss.
    log(`  attempt ${attempt} failed verification:\n${truncate(failures.join("\n"), 1200)}`);
    if (attempt < totalAttempts) {
      const scopeNote = applied.rejected.length > 0
        ? `\n\nNote: these returned paths were ignored as out of scope: ${applied.rejected.join(", ")}. Only touch: ${scope.join(", ")}.`
        : "";
      messages.push({ role: "user", content: `Verification failed:\n\n${result.lastErrors}${scopeNote}\n\nFix these errors. ${reemit}` });
    }
  }

  // --- Self-review of the green result. One fix attempt; a fix that does not
  //     come back green is rolled back, so review can never make things worse.
  if (result.green && reviewOn) {
    log(`[${name}] self-review`);
    const verified = await readScope(root, [...touched]);
    const sections: string[] = [];
    for (const f of verified) {
      sections.push(patch
        ? `--- ${f.path}: unified diff of the change (+ added, - removed) ---\n${await unifiedDiff(opts.workDir, f.path, baseline.get(f.path) ?? null, f.content, REVIEW_DIFF_CONTEXT)}`
        : `--- ${f.path} ---\n${numbered(f.content)}`);
    }
    let findings: string | null = null;
    try {
      findings = await reviewFiles(pass.task, checks, sections, opts);
    } catch (e) {
      log(`  review request failed: ${(e as Error).message}`);
      result.review = "error";
    }
    if (findings === null && result.review !== "error") {
      result.review = "OK";
    } else if (findings !== null) {
      log(`  review found:\n${findings}`);
      result.reviewNotes = findings;
      messages.push({
        role: "user",
        content: `A code review of your output found these defects:\n\n${findings}\n\nFix ONLY these defects. Change nothing else. ${reemit}`,
      });
      result.attempts++;
      let fixed = false;
      try {
        if (!fitTranscript(messages, maxTokens, opts.ctx)) throw new Error(`the fix prompt does not fit the ${opts.ctx} tok context`);
        const fix = await chat(messages, opts.model, maxTokens, GEN_TEMPERATURE, opts.url);
        log(`  fix attempt: ${Math.round(fix.elapsedMs / 1000)}s, finish=${fix.finishReason ?? "?"}`);
        if (fix.finishReason !== "length") {
          const extracted = extract(fix.content);
          if (extracted.errors.length > 0) {
            log(`  fix edits not applied:\n${truncate(extracted.errors.join("\n"), 1200)}`);
          } else {
            const applied = await applyResponse(extracted.files, scope, baseline, pass.allowShrink === true, root);
            if (!applied.boundary && applied.shrunk.length === 0 && applied.accepted.length > 0) {
              for (const p of applied.accepted) touched.add(p);
              const failures = await runGate(root, pass, eslintTargets, false, opts.gateTimeoutMs);
              const outcome = await checkAsserts(root, asserts, scope);
              if (failures.length === 0 && outcome.failures.length === 0) {
                result.asserts = outcome;
                fixed = true;
              } else {
                log(`  fix failed verification:\n${truncate(failures.concat(outcome.failures).join("\n"), 1200)}`);
              }
            }
          }
        }
      } catch (e) {
        log(`  fix request failed: ${(e as Error).message}`);
      }
      if (fixed) {
        result.review = "fixed";
      } else {
        for (const f of verified) await writeFile(resolveWithinRoot(root, f.path), f.content);
        result.review = "kept-verified";
        log(`  rolled back to the verified version; review notes are in the report`);
      }
    }
  }

  // --- Per-file report data.
  for (const p of touched) {
    const abs = resolveWithinRoot(root, p);
    const after = existsSync(abs) ? await readFile(abs, "utf8") : "";
    const before = baseline.get(p) ?? null;
    const { added, removed } = before === null ? { added: countLines(after), removed: 0 } : diffCounts(await unifiedDiff(opts.workDir, p, before, after));
    result.files.push({ path: p, lines: countLines(after), isNew: before === null, added, removed });
  }
  return finish();
}

// ---------------------------------------------------------------------------
// Ask mode: read-only. The model explores the project with read_file, list_dir
// and grep and answers a question. Nothing is written. Every path is sandboxed
// to root; binaries and oversized files are refused; reads are budgeted; each
// distinct call runs once; tool turns get a small token budget, and a runaway
// turn is thrown away, so the model cannot spiral into unbounded exploration.
// ---------------------------------------------------------------------------

interface AskSpec {
  ask: string;
  root?: string;
  model?: string;
  readBudget?: number;
  maxTurns?: number;
  maxReadChars?: number;
  maxFileBytes?: number;
  maxTokens?: number;
  toolTurnTokens?: number;
  presencePenalty?: number;
}

const BINARY_EXTS = new Set([
  ".onnx", ".pdf", ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
  ".mp3", ".mp4", ".wav", ".flac", ".mov", ".avi", ".mkv", ".ogg", ".m4a",
  ".pkl", ".bin", ".pt", ".safetensors", ".gguf", ".ggml",
  ".exe", ".dll", ".dylib", ".so", ".a", ".o",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".jar", ".class", ".pyc", ".pyo",
  ".sqlite", ".sqlite3", ".db",
]);
const SKIP_DIRS = [
  ".git", "node_modules", ".next", ".nuxt", ".svelte-kit", "dist", "build", "out", "target",
  ".venv", "venv", "__pycache__", ".cache", ".turbo", ".parcel-cache", "vendor", "coverage",
];
const GREP_SUMMARY_OVER = 200;  // more matches than this come back as per-file counts, not lines
const MAX_GREP_SUMMARY_FILES = 80;
const MAX_GREP_PER_FILE = 40;   // rg --max-count is PER FILE, not global
const MAX_GREP_LINE = 200;
const MAX_LIST_ENTRIES = 300;
const MAX_STDIN_CHARS = 200_000;
const MIN_TOOL_ROOM_CHARS = 500;

const ASK_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a text file inside the project. Binary files and files over the byte cap are refused; " +
        "long files are truncated to head and tail. Read each file once: its content stays in the " +
        "conversation, and reading it again returns only a short note.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path relative to the project root." } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List the entries of a directory inside the project, one per line, marked DIR or FILE. Free.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Directory relative to the project root. '.' is the root." } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        `Regex search across text files under a directory. Returns matches as path:line:text; over ${GREP_SUMMARY_OVER} matches ` +
        "it returns only a count per file, so start with a specific symbol or string and a path, not a common word. " +
        "Skips binaries, build output and ignored files. Free: use it instead of reading many files.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex, ripgrep syntax." },
          path: { type: "string", description: "Directory or file relative to the project root. Default '.'." },
          glob: { type: "string", description: "Optional filename glob such as '*.ts'." },
        },
        required: ["pattern"],
      },
    },
  },
];

interface AskState {
  root: string;
  readBudget: number;
  maxReadChars: number;
  maxFileBytes: number;
  reads: number;
  greps: number;
  lists: number;
  budgetExhausted: boolean;
}

function safePath(root: string, raw: string): { abs: string; rel: string } | string {
  try {
    const abs = resolveWithinRoot(root, raw || ".");
    return { abs, rel: relative(root, abs) || "." };
  } catch {
    return `Error: path "${raw}" is outside the project root.`;
  }
}

async function looksBinary(abs: string): Promise<string | null> {
  const ext = extname(abs).toLowerCase();
  if (BINARY_EXTS.has(ext)) return `extension ${ext} is binary`;
  const head = new Uint8Array(await Bun.file(abs).slice(0, 1024).arrayBuffer());
  return head.includes(0) ? "file contains null bytes" : null;
}

/** Cuts a list or grep result to the context that is left, and says so. */
function fitResult(text: string, room: number, what: string): string {
  if (text.length <= room) return text;
  const cut = text.slice(0, Math.max(0, room - 200));
  return `${cut.slice(0, cut.lastIndexOf("\n") + 1)}[${what} cut to fit the context that is left; narrow the pattern or path]`;
}

async function toolReadFile(state: AskState, args: { path?: unknown }, room: number): Promise<string> {
  const p = safePath(state.root, String(args.path ?? ""));
  if (typeof p === "string") return p;
  if (!existsSync(p.abs)) return `Error: "${p.rel}" does not exist.`;
  const st = statSync(p.abs);
  if (!st.isFile()) return `Error: "${p.rel}" is not a regular file.`;
  if (st.size > state.maxFileBytes) {
    return `Error: "${p.rel}" is ${st.size} bytes, over the ${state.maxFileBytes}-byte cap. Use grep on it instead.`;
  }
  const bin = await looksBinary(p.abs);
  if (bin) return `Error: refusing to read "${p.rel}": ${bin}.`;
  if (state.reads >= state.readBudget) {
    state.budgetExhausted = true;
    return `Error: read budget exhausted (${state.readBudget} files). Use grep, or answer with what you have.`;
  }
  let content = await readFile(p.abs, "utf8");
  if (content.length > state.maxReadChars) {
    const head = Math.floor(state.maxReadChars * 0.6);
    const tail = state.maxReadChars - head;
    const headText = content.slice(0, head);
    const tailText = content.slice(-tail);
    const totalLines = content.split("\n").length;
    const firstDropped = headText.split("\n").length;
    const lastDropped = totalLines - tailText.split("\n").length + 1;
    content = `${headText}\n\n...[truncated: ${content.length} chars, ${totalLines} lines; lines ${firstDropped}-${lastDropped} omitted — grep this file for anything in that range]...\n\n${tailText}`;
  }
  if (content.length > room) {
    return `Error: "${p.rel}" is ${content.length} chars, but only about ${room} chars of context are left. Grep it instead, or answer with what you have.`;
  }
  state.reads++;
  return content;
}

function toolListDir(state: AskState, args: { path?: unknown }, room: number): string {
  const p = safePath(state.root, String(args.path ?? "."));
  if (typeof p === "string") return p;
  if (!existsSync(p.abs) || !statSync(p.abs).isDirectory()) return `Error: "${p.rel}" is not a directory.`;
  state.lists++;
  const isDir = (name: string): boolean => {
    try {
      return statSync(join(p.abs, name)).isDirectory(); // follows symlinks
    } catch {
      return false;
    }
  };
  const entries = readdirSync(p.abs)
    .map((name) => ({ name, dir: isDir(name) }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  const lines = entries.slice(0, MAX_LIST_ENTRIES).map((e) => `${e.dir ? "DIR " : "FILE"}  ${e.name}`);
  if (entries.length > MAX_LIST_ENTRIES) lines.push(`(+${entries.length - MAX_LIST_ENTRIES} more)`);
  return lines.length > 0 ? fitResult(lines.join("\n"), room, "listing") : "(empty)";
}

let rgAvailable: boolean | null = null;

async function toolGrep(state: AskState, args: { pattern?: unknown; path?: unknown; glob?: unknown }, room: number): Promise<string> {
  const pattern = String(args.pattern ?? "");
  if (!pattern) return "Error: grep needs a pattern.";
  const p = safePath(state.root, String(args.path ?? "."));
  if (typeof p === "string") return p;
  if (!existsSync(p.abs)) return `Error: "${p.rel}" does not exist.`;
  state.greps++;
  if (rgAvailable === null) rgAvailable = Bun.which("rg") !== null;
  const glob = args.glob ? String(args.glob) : "";
  const cmd = rgAvailable
    ? ["rg", "-nH", "--no-heading", "--color", "never", "--no-messages", "--max-count", String(MAX_GREP_PER_FILE),
       ...(glob ? ["-g", glob] : []), "-e", pattern, p.rel]
    : ["grep", "-rnHIE", ...SKIP_DIRS.map((d) => `--exclude-dir=${d}`),
       ...(glob ? [`--include=${glob}`] : []), "-e", pattern, p.rel];
  const proc = Bun.spawn(cmd, { cwd: state.root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code === 1) return `No matches for /${pattern}/ in ${p.rel}.`;
  if (code !== 0) return `Error: grep failed: ${stderr.trim().slice(0, 300) || `exit ${code}`}`;
  const lines = stdout.split("\n").filter(Boolean);
  const perFile = new Map<string, number>();
  for (const l of lines) {
    const f = l.slice(0, l.indexOf(":"));
    perFile.set(f, (perFile.get(f) ?? 0) + 1);
  }
  const atCap = (n: number) => rgAvailable === true && n >= MAX_GREP_PER_FILE;
  // A broad first grep ("order", "notification") used to hand back 400 lines, ~13k
  // tokens that every later turn re-paid in prefill. Past the threshold the model
  // gets where the hits cluster and drills in with a path or a tighter pattern.
  if (lines.length > GREP_SUMMARY_OVER) {
    const files = [...perFile.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const capped = files.filter(([, n]) => atCap(n)).length;
    const out = [
      `${lines.length}${capped > 0 ? "+" : ""} matches for /${pattern}/ in ${files.length} files: too many to list. ` +
        `Matches per file, most first${capped > 0 ? ` ("${MAX_GREP_PER_FILE}+" = at the per-file cap)` : ""}. ` +
        "To see lines, grep one path or a tighter pattern:",
      ...files.slice(0, MAX_GREP_SUMMARY_FILES).map(([f, n]) => `${f}: ${atCap(n) ? `${MAX_GREP_PER_FILE}+` : n}`),
    ];
    if (files.length > MAX_GREP_SUMMARY_FILES) out.push(`(+${files.length - MAX_GREP_SUMMARY_FILES} more files)`);
    return fitResult(out.join("\n"), room, "grep output");
  }
  const shown = lines.map((l) => (l.length > MAX_GREP_LINE ? l.slice(0, MAX_GREP_LINE) + "…" : l));
  const capped = [...perFile.values()].filter((n) => atCap(n)).length;
  if (capped > 0) shown.push(`[${capped} file(s) hit the ${MAX_GREP_PER_FILE}-match-per-file cap and may have more; grep those paths directly]`);
  return fitResult(shown.join("\n"), room, "grep output");
}

/** The call's arguments as an object, or null for a half-written or malformed call. */
function parseToolArgs(call: ToolCall): Record<string, unknown> | null {
  try {
    const v: unknown = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A call's identity, so "./a.ts" and "a.ts", or a missing and a "." path, count as the same call. */
function callKey(root: string, name: string, args: Record<string, unknown>): string {
  const norm: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined && v !== null && v !== "") norm[k] = String(v);
  }
  const p = safePath(root, norm.path ?? ".");
  if (typeof p !== "string") norm.path = p.rel;
  return `${name} ${JSON.stringify(Object.keys(norm).sort().map((k) => [k, norm[k]]))}`;
}

/** `room` is how many chars of result still fit the context. */
async function executeTool(state: AskState, name: string, args: Record<string, unknown>, room: number): Promise<string> {
  if (room < MIN_TOOL_ROOM_CHARS) return "Error: the context window is nearly full. Answer now with what you have.";
  switch (name) {
    case "read_file": return toolReadFile(state, args, room);
    case "list_dir": return toolListDir(state, args, room);
    case "grep": return toolGrep(state, args, room);
    default: return `Error: unknown tool "${name}".`;
  }
}

/** Why a tool turn must be thrown away, or null when it is usable. */
function brokenTurn(r: ChatResult, budget: number): string | null {
  const calls = r.toolCalls.length;
  if (calls > MAX_TOOL_CALLS_PER_TURN) return `made ${calls} tool calls, over the limit of ${MAX_TOOL_CALLS_PER_TURN} per turn`;
  if (r.finishReason === "length") return `was cut off at the ${budget} token limit${calls > 0 ? ` after ${calls} tool call(s)` : ""}`;
  if (r.toolCalls.some((c) => parseToolArgs(c) === null)) return "held a half-written or malformed tool call";
  if (calls === 0 && r.content.includes("<tool_call>")) return "held a tool call the server could not parse";
  return null;
}

interface AskOptions {
  root: string;
  url: string;
  model: string;
  maxTokens: number;
  ctx: number;
  readBudget: number;
  maxTurns: number;
  maxReadChars: number;
  maxFileBytes: number;
  toolTurnTokens: number;
  presencePenalty: number;
}

interface AskResult {
  answer: string | null;
  turns: number;
  state: AskState;
  truncated: boolean;
  note: string;
  elapsedMs: number;
  /** Turns thrown away: cut off, too many calls, or a malformed call. */
  discarded: number;
  /** Tool use ended early because a retried turn was thrown away too. */
  toolsEnded: boolean;
  /** Calls not run again: duplicates within a turn, or repeats of an earlier turn. */
  repeats: number;
  /** Tool use ended early because STALL_TURNS turns in a row only repeated earlier calls. */
  stalled: boolean;
  /** Why the answer turn had no tools, when the model did not choose to answer: out of turns, or out of context. */
  forced: "turns" | "context" | null;
  /** Size of the transcript when the run ended, for the usage log. */
  contextTokens: number;
}

function askSystemPrompt(opts: AskOptions): string {
  return [
    `You are a senior engineer answering a question about the project at ${opts.root}.`,
    `Tools: read_file, list_dir, grep. Budget: ${opts.readBudget} file reads and ${opts.maxTurns} turns. list_dir and grep cost no reads, but every turn counts.`,
    "",
    "Rules:",
    "- Look before you answer. Never guess at code you have not seen.",
    "- grep first when you look for a symbol, string or pattern. Use a specific pattern and a path; a common word only returns counts. Read only the files that matter.",
    `- Batch independent tool calls into one turn, at most ${MAX_TOOL_CALLS_PER_TURN} calls per turn.`,
    "- Never repeat a call. Do not re-list a directory or re-read a file you already saw.",
    "- Around 60% of the read budget or of the turns, stop gathering and write the answer.",
    "- When you have nothing new to look up, answer. Do not search again for what you already found.",
    "- Cite path:line for every concrete claim.",
    "- When you can answer, reply in plain text with no tool call. Lead with the answer, cover every part of the question, then stop: no preamble, no restating the question, no closing summary. Do not apologise.",
  ].join("\n");
}

function validateAsk(spec: AskSpec): void {
  rejectUnknownKeys(spec, ASK_KEYS, "ask spec");
  if (typeof spec.ask !== "string" || !spec.ask.trim()) die(`"ask" must be a non-empty string`, 4);
  for (const k of ["readBudget", "maxTurns", "maxReadChars", "maxFileBytes", "maxTokens", "toolTurnTokens"] as const) {
    const v = spec[k];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v <= 0)) die(`"${k}" must be a positive number`, 4);
  }
  const pp = spec.presencePenalty;
  if (pp !== undefined && (typeof pp !== "number" || !Number.isFinite(pp) || pp < 0)) die(`"presencePenalty" must be a number >= 0`, 4);
}

async function runAsk(question: string, opts: AskOptions): Promise<AskResult> {
  const started = Date.now();
  const state: AskState = {
    root: opts.root, readBudget: opts.readBudget, maxReadChars: opts.maxReadChars, maxFileBytes: opts.maxFileBytes,
    reads: 0, greps: 0, lists: 0, budgetExhausted: false,
  };
  const result: AskResult = {
    answer: null, turns: 0, state, truncated: false, note: "", elapsedMs: 0, discarded: 0, toolsEnded: false, repeats: 0,
    stalled: false, forced: null, contextTokens: 0,
  };
  const messages: ChatMessage[] = [
    { role: "system", content: askSystemPrompt(opts) },
    { role: "user", content: question },
  ];
  const done = new Set<string>(); // keys of calls whose full result is already in the transcript
  const sampling = { presence_penalty: opts.presencePenalty };
  let retrying = false;
  let idleTurns = 0; // turns in a row whose every call repeated an earlier one
  const nudgeTurn = opts.maxTurns >= TURN_NUDGE_MIN_TURNS ? Math.ceil(opts.maxTurns * TURN_NUDGE_AT) + 1 : 0;
  let nudged = false;

  const request = async (budget: number, tools: ToolDef[] | undefined): Promise<ChatResult> => {
    const r = await chat(messages, opts.model, budget, ASK_TEMPERATURE, opts.url, tools, sampling);
    log(`  ${Math.round(r.elapsedMs / 1000)}s, ${r.toolCalls.length} tool call(s), ${r.content.length} chars, finish=${r.finishReason ?? "?"}`);
    return r;
  };

  for (let turn = 1; turn <= opts.maxTurns; turn++) {
    result.turns = turn;
    const last = turn === opts.maxTurns;
    const nearCeiling = transcriptTokens(messages) + opts.maxTokens > opts.ctx * 0.9;
    let tools: ToolDef[] | undefined = ASK_TOOLS.filter((t) => !(state.budgetExhausted && t.function.name === "read_file"));
    let forced: AskResult["forced"] = null;
    if (last || nearCeiling || result.toolsEnded || result.stalled) {
      tools = undefined;
      const why = result.stalled ? `Your last ${STALL_TURNS} turns only repeated calls you had already made, so there is nothing new to find.`
        : result.toolsEnded ? "Your tool calls kept failing, so tool use has ended."
        : last ? "This is your last turn."
        : "The conversation is near the context limit.";
      if (!result.stalled && !result.toolsEnded) forced = last ? "turns" : "context";
      messages.push({ role: "user", content: `${why} Answer now with what you have. Do not call tools.` });
    } else if (turn === nudgeTurn && !nudged) {
      nudged = true;
      messages.push({
        role: "user",
        content: `Turn ${turn} of ${opts.maxTurns}. ${opts.maxTurns - turn} turn(s) are left after this one, and the last one allows no tools. Make only the calls you still need, then answer.`,
      });
    }
    // Checked before every call, not once: the transcript grows each turn.
    const promptTokens = transcriptTokens(messages);
    if (promptTokens + opts.maxTokens > opts.ctx) {
      result.note = `prompt ~${promptTokens} tok + answer budget ${opts.maxTokens} tok exceeds the ${opts.ctx} tok context ceiling`;
      log(`[ask] not sending: ${result.note}`);
      break;
    }
    const budget = tools ? Math.min(opts.toolTurnTokens, opts.maxTokens) : opts.maxTokens;
    log(`[ask] turn ${turn}/${opts.maxTurns}${retrying ? " (retry)" : ""}: prompt ~${promptTokens} tok, reads ${state.reads}/${opts.readBudget}, budget ${budget}${tools ? "" : " (answer only)"}`);

    let r: ChatResult;
    let used = budget;
    try {
      r = await request(budget, tools);
      // A tool turn's small budget stops a runaway loop in seconds. A plain answer
      // that outgrows it is not a loop: ask again with the full answer budget.
      if (tools && r.finishReason === "length" && r.toolCalls.length === 0 && r.content.trim() && !r.content.includes("<tool_call>")) {
        used = opts.maxTokens;
        log(`  the answer outgrew the ${budget} tok tool-turn budget; asking again with ${used}`);
        r = await request(used, tools);
      }
    } catch (e) {
      result.note = `model server request failed: ${(e as Error).message}`;
      break;
    }

    // Never keep a broken turn: a half-written call in the transcript is what made
    // the next prompt millions of tokens long and the server fail.
    const broken = tools ? brokenTurn(r, used) : null;
    if (broken) {
      result.discarded++;
      if (!retrying) {
        retrying = true;
        log(`  threw the turn away: it ${broken}. Retrying once.`);
        messages.push({
          role: "user",
          content: `Your last reply was thrown away because it ${broken}. Make each distinct tool call once, at most ${MAX_TOOL_CALLS_PER_TURN} calls in a turn, or answer in plain text.`,
        });
        turn--;
        continue;
      }
      log(`  threw the retry away too: it ${broken}. Tool use has ended.`);
      retrying = false;
      result.toolsEnded = true;
      continue;
    }
    retrying = false;

    if (tools && r.toolCalls.length > 0) {
      const calls: { call: ToolCall; key: string; args: Record<string, unknown> }[] = [];
      const keys = new Set<string>();
      for (const call of r.toolCalls) {
        const args = parseToolArgs(call)!;
        const key = callKey(opts.root, call.function.name, args);
        if (keys.has(key)) continue;
        keys.add(key);
        calls.push({ call, key, args });
      }
      const dupes = r.toolCalls.length - calls.length;
      if (dupes > 0) {
        result.repeats += dupes;
        log(`  dropped ${dupes} duplicate call(s) from this turn`);
      }
      messages.push({ role: "assistant", content: r.content || null, tool_calls: calls.map((c) => c.call) });
      let fresh = 0; // calls in this turn that were not repeats of an earlier turn
      for (const { call, key, args } of calls) {
        let out: string;
        if (done.has(key)) {
          result.repeats++;
          out = `Already done in an earlier turn: that ${call.function.name} result is above and has not changed. Do not repeat this call. If you have nothing new to look up, answer now in plain text.`;
        } else {
          const room = Math.floor((opts.ctx * 0.9 - opts.maxTokens - transcriptTokens(messages)) * CHARS_PER_TOKEN);
          out = await executeTool(state, call.function.name, args, room);
          if (!out.startsWith("Error:")) done.add(key);
          fresh++;
        }
        const err = out.startsWith("Error:") ? ` ${out.slice(0, 120)}` : "";
        log(`  ${call.function.name}(${call.function.arguments.slice(0, 120)}) -> ${out.length} chars${err}`);
        messages.push({ role: "tool", tool_call_id: call.id, content: out });
      }
      idleTurns = fresh === 0 ? idleTurns + 1 : 0;
      if (idleTurns >= STALL_TURNS) {
        log(`  ${idleTurns} turns in a row only repeated earlier calls. Tool use has ended.`);
        result.stalled = true;
      }
      continue;
    }
    if (r.content.trim()) {
      result.answer = r.content.trim();
      result.truncated = r.finishReason === "length";
      result.forced = forced;
      break;
    }
    messages.push({ role: "assistant", content: "" });
    messages.push({ role: "user", content: "Your reply was empty. Answer the question in plain text." });
  }
  if (result.answer === null && !result.note) result.note = `no answer after ${result.turns} turn(s)`;
  result.elapsedMs = Date.now() - started;
  result.contextTokens = transcriptTokens(messages);
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const BOOLEAN_FLAGS = new Set(["help", "diff", "no-review", "allow-dirty-gate", "stdin"]);
const VALUE_FLAGS = new Set([
  "root", "model", "url", "max-retries", "max-tokens", "ctx", "log", "lock-wait", "gate-timeout", "ask", "read-budget", "max-turns",
  "max-read-chars", "max-file-bytes", "tool-turn-tokens", "presence-penalty",
]);

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") { flags.help = true; continue; }
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const name = a.slice(2);
    if (BOOLEAN_FLAGS.has(name)) { flags[name] = true; continue; }
    if (VALUE_FLAGS.has(name)) {
      const v = argv[++i];
      if (v === undefined) die(`--${name} needs a value`, 4);
      flags[name] = v;
      continue;
    }
    die(`unknown option --${name} (see --help)`, 4);
  }
  return { flags, positional };
}

const HELP = `delegate-loop — hand work to a local model and print a short report.

Usage:
  delegate-loop.ts <spec.json> [options]            write mode (spec has task/scope or passes)
                                                    or ask mode (spec has "ask")
  delegate-loop.ts --ask "question" --root DIR      ask mode without a spec file

Options:
  --root DIR           Target project root (overrides spec.root)
  --model NAME         Model id (else spec.model, DELEGATE_MODEL, the config file, or the only model served)
  --url URL            Server base URL (else DELEGATE_URL, the config file, or ${FALLBACK_URL})
  --max-tokens N       Generation budget per model call (default: ${DEFAULT_MAX_TOKENS}; write mode grows it on truncation)
  --ctx N              Context ceiling in tokens, checked before every model call (else DELEGATE_CTX, the
                       config file, the size the server reports at /props, or ${FALLBACK_CTX})
  --log FILE           Write progress to FILE instead of stderr; stdout is then the report only
  --lock-wait N        Seconds to wait while another run uses the server (default: ${DEFAULT_LOCK_WAIT_S}; 0 = fail at once)
  --help               Show this message
Write mode:
  --max-retries N      Retries after the first attempt (default: ${DEFAULT_MAX_RETRIES})
  --diff               Print a unified diff of every file written, after the report
  --no-review          Skip the model's self-review pass
  --allow-dirty-gate   Continue even if the gate already fails on the unchanged tree
  --gate-timeout N     Seconds one gate command may run before it is killed and counted as failed
                       (default: ${DEFAULT_GATE_TIMEOUT_S}; 0 = no limit)
Ask mode:
  --ask QUESTION       The question (or put "ask" in the spec)
  --read-budget N      Max read_file calls (default: ${DEFAULT_READ_BUDGET}); list_dir and grep are free
  --max-turns N        Max model turns (default: ${DEFAULT_MAX_TURNS})
  --max-read-chars N   Per-file char cap before head/tail truncation (default: ${DEFAULT_MAX_READ_CHARS})
  --max-file-bytes N   Refuse to read files larger than this (default: ${DEFAULT_MAX_FILE_BYTES})
  --tool-turn-tokens N Budget of a turn that may call tools (default: ${DEFAULT_TOOL_TURN_TOKENS}); an answer that
                       outgrows it is asked for again with --max-tokens
  --presence-penalty N Sampling presence penalty (default: ${DEFAULT_PRESENCE_PENALTY}); guards against repetition loops
  --stdin              Attach stdin to the question, e.g. tail -500 x.log | delegate-loop.ts --ask "..." --stdin

Settings, first match wins: flag > environment > config file > detection > built-in.
The config file is ${CONFIG_PATH} (DELEGATE_CONFIG moves it) and holds {"url", "model",
"ctx"}. The server is anything OpenAI-compatible with streaming and tool calls:
llama-server, llama-swap, Ollama, LM Studio, vLLM. llama-server reports its context
size at /props (behind llama-swap, /upstream/<model>/props); other servers do not,
so set "ctx" to the model's real context size or prompts that overflow it are cut
by the server without a word. DELEGATE_USAGE_LOG and DELEGATE_LOCK_DIR move the usage
log (${USAGE_LOG}) and the lock directory.

Ask mode is read-only: the model explores the project with read_file, list_dir
and grep (sandboxed to root, binaries refused, reads budgeted) and prints its
answer, then a STATUS line with the turn and read counts. File contents stay in
the local model, not in the caller's context. Each distinct call runs once. A turn
that is cut off, makes more than ${MAX_TOOL_CALLS_PER_TURN} calls, or holds a malformed call is thrown away
and retried once; a second bad turn ends tool use and a WARNING says so. ${STALL_TURNS} turns in a
row that only repeat earlier calls end tool use too. A WARNING also says when the
answer was forced because the turns or the context ran out.

One run at a time: the server has one slot, so a second run waits for the first
(see --lock-wait) and prints a NOTE saying how long it waited and for whom.

Spec (JSON), write mode, one pass:
  {
    "root": "/absolute/path/to/project",
    "task": "the contract: what to build, every exported name and signature, edge behavior",
    "scope": ["src/utils/money.ts"],
    "context": ["src/types/money.ts"],
    "assert": [
      "export function formatMoney(cents: number): string",
      { "text": ": any", "absent": true },
      { "regex": "^import .* from \\"\\\\./types\\"" }
    ],
    "verify": [["/usr/bin/python3", "-m", "py_compile", "x.py"]],
    "maxTokens": 4000,
    "patch": false,
    "review": true
  }

Several passes: replace "task"/"scope"/... with "passes": [ {...}, {...} ]. They run
in order in one process (the model loads once), a later pass may list an earlier
pass's output in "context", and a failing pass stops the batch.

"patch": true — for a file too big to re-emit whole. The model answers with
<<<EDIT path>>> <<<SEARCH>>> old lines <<<REPLACE>>> new lines <<<END>>> blocks,
applied to the original file, all or nothing. SEARCH must match exactly one place
(trailing whitespace and indentation are forgiven). New files still use <<<FILE>>>.
The self-review is shown the diff, not the whole file.

"assert" — contract checks. A plain string is literal text that must appear in a
scope file (whitespace-tolerant, no escaping needed). {"text": ..., "absent": true}
must NOT appear. {"regex": ...} is a JavaScript regex. Failures are fed back to the
model like compiler errors, so the loop self-corrects on the contract.

"verify" — the gate for non-TypeScript projects: argv arrays run in root, all must
exit 0. Without it the gate is tsc + eslint on the scope files, which needs
tsconfig.json and an eslint config in root. Check only files that already exist.

Refuses paths that name: auth, migrations, RLS, security definer, entitlements,
.server.* — on the declared scope/context and on every path the model returns.

A spec with an unknown key, an assert "file" outside "scope", or (per pass) a
"context" file that does not exist is refused before any model call.

Never commits or pushes. Exit codes: 0 green/answered, 1 internal error, 2 failed,
3 server/model unavailable, 4 bad spec or setup.`;

// ---------------------------------------------------------------------------
// Run lock. The server runs the delegate model with one slot (-np 1), so a
// second run's requests just queue inside the server and both runs look hung.
// One lock file per server URL; a second run waits and logs who holds it.
// ---------------------------------------------------------------------------

interface LockHolder {
  pid: number;
  mode: string;
  root: string;
  started: string;
}

interface LockWait {
  waitedS: number;
  /** The run this one waited for, or null when the lock was free. */
  holder: LockHolder | null;
}

let heldLock: string | null = null;
let queueTicket: string | null = null;

function lockPath(url: string): string {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // an odd --url still gets its own lock file
  }
  return join(LOCK_DIR, `${host.replace(/[^A-Za-z0-9.-]+/g, "_")}.lock`);
}

function readHolder(path: string): LockHolder | null {
  try {
    const h = JSON.parse(readFileSync(path, "utf8")) as LockHolder;
    return typeof h.pid === "number" ? h : null;
  } catch {
    return null;
  }
}

/** True when pid is a live delegate-loop process; a pid reused by something else counts as gone. */
function holderAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("delegate-loop");
  } catch {
    return true; // no /proc: trust kill(0)
  }
}

function describeHolder(h: LockHolder | null): string {
  return h ? `pid ${h.pid}, ${h.mode} on ${h.root}, started ${h.started}` : "pid unknown";
}

/** Queue tickets of other live waiters that arrived before `mine`; clears dead ones. */
function ticketsAhead(queueDir: string, mine: string): string[] {
  const ahead: string[] = [];
  for (const name of readdirSync(queueDir)) {
    if (name >= mine) continue;
    let ageMs: number;
    try {
      ageMs = Date.now() - statSync(join(queueDir, name)).mtimeMs;
    } catch {
      continue; // it just took the lock or gave up
    }
    // A waiter touches its ticket every poll, so an untouched ticket with no live pid is dead.
    if (ageMs > TICKET_STALE_MS && !holderAlive(Number(name.split("-")[1]))) {
      rmSync(join(queueDir, name), { force: true });
      continue;
    }
    ahead.push(name);
  }
  return ahead;
}

async function acquireLock(url: string, mode: string, root: string, waitS: number): Promise<LockWait> {
  const path = lockPath(url);
  const queueDir = `${path}.queue`;
  mkdirSync(queueDir, { recursive: true });
  const started = Date.now();
  const info = JSON.stringify({ pid: process.pid, mode, root, started: new Date(started).toISOString() });
  // Waiters take the lock in arrival order. Without a queue, a run started the moment
  // the lock frees (a script looping over asks) wins every race and starves the rest.
  const ticket = `${String(started).padStart(15, "0")}-${process.pid}`;
  const ticketPath = join(queueDir, ticket);
  writeFileSync(ticketPath, info);
  queueTicket = ticketPath;
  let waitingOn: LockHolder | null = null;
  let queuedBehind = 0;
  for (;;) {
    try {
      utimesSync(ticketPath, new Date(), new Date());
    } catch {
      writeFileSync(ticketPath, info); // cleared as stale while this process was paused
    }
    const ahead = ticketsAhead(queueDir, ticket);
    if (ahead.length === 0) {
      try {
        writeFileSync(path, info, { flag: "wx" });
        heldLock = path;
        rmSync(ticketPath, { force: true });
        queueTicket = null;
        setInterval(() => {
          try {
            utimesSync(path, new Date(), new Date());
          } catch {
            // lock removed under us; nothing to keep alive
          }
        }, LOCK_HEARTBEAT_MS).unref();
        return { waitedS: Math.round((Date.now() - started) / 1000), holder: waitingOn };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") die(`cannot create the run lock ${path}: ${(e as Error).message}`, 4);
      }
    }
    const holder = readHolder(path);
    let ageMs = Infinity;
    try {
      ageMs = Date.now() - statSync(path).mtimeMs;
    } catch {
      // no lock file: free, or released a moment ago
    }
    // Stale only when its pid is gone AND its heartbeat stopped. The age check covers a
    // holder mid-write, and a holder in a sandbox whose pids this process cannot see.
    if (ageMs !== Infinity && ageMs > LOCK_STALE_MS && !(holder && holderAlive(holder.pid))) {
      log(`removing a stale run lock (${holder ? `pid ${holder.pid} is gone` : "unreadable"}): ${path}`);
      rmSync(path, { force: true });
      continue;
    }
    if (holder && holder.pid !== waitingOn?.pid) {
      waitingOn = holder;
      log(
        `waiting: another delegate-loop run (${describeHolder(holder)}) is using the model. ` +
        `The server answers one request at a time, so this run starts when that one ends (--lock-wait ${waitS}s).`,
      );
    }
    if (ahead.length > 0 && ahead.length !== queuedBehind) {
      log(`waiting: ${ahead.length} earlier run(s) are queued for the model ahead of this one.`);
      waitingOn ??= holder;
    }
    queuedBehind = ahead.length;
    if (Date.now() - started >= waitS * 1000) {
      const who = holder ?? waitingOn;
      die(
        `another delegate-loop run (${describeHolder(who)}) still holds the model after ${waitS}s of waiting` +
        `${ahead.length > 0 ? `, with ${ahead.length} run(s) queued ahead` : ""}. Let it finish, or raise --lock-wait`,
        3,
      );
    }
    await Bun.sleep(LOCK_POLL_MS);
  }
}

function releaseLock() {
  if (queueTicket) rmSync(queueTicket, { force: true });
  queueTicket = null;
  if (heldLock && readHolder(heldLock)?.pid === process.pid) rmSync(heldLock, { force: true });
  heldLock = null;
}

process.on("exit", releaseLock);
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
  process.on(signal, () => process.exit(code));
}

function waitNote(w: LockWait): string | null {
  if (!w.holder) return null;
  return `NOTE: waited ${w.waitedS}s for another delegate-loop run (${describeHolder(w.holder)}). The server runs one request at a time; runs queue, they do not go faster in parallel.`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function fileTag(f: FileReport): string {
  return `${f.path}:${f.lines}L(${f.isNew ? "new" : `+${f.added}/-${f.removed}`})`;
}

/**
 * Reaches the server, settles the model (the configured one, else the only one
 * served) and the context ceiling (the configured one, else what the server
 * reports, else the fallback). Called after the run lock is held, because behind
 * llama-swap the /props probe loads the model and must not swap out another run's.
 */
async function checkServer(url: string, model: string | null, ctxSetting: number | null): Promise<{ model: string; ctx: number }> {
  let available: string[];
  try {
    available = await listModels(url);
  } catch (e) {
    die(`cannot reach the model server at ${url} (${(e as Error).message}). Is it running? If it listens elsewhere, pass --url, set DELEGATE_URL, or put "url" in ${CONFIG_PATH}`, 3);
  }
  const how = `pass --model, set DELEGATE_MODEL, or put "model" in ${CONFIG_PATH}`;
  if (model === null) {
    if (available!.length === 1) {
      model = available![0]!;
      log(`model: ${model} (the only one served at ${url})`);
    } else if (available!.length === 0) {
      die(`the server at ${url} lists no models; ${how}`, 3);
    } else {
      die(`the server at ${url} serves ${available!.length} models and none is configured: ${available!.join(", ")}. Pick one: ${how}`, 3);
    }
  } else if (!available!.includes(model)) {
    die(`model "${model}" is not served at ${url}. Available: ${available!.join(", ") || "(none)"}`, 3);
  }
  let ctx = ctxSetting;
  if (ctx === null) {
    ctx = await probeCtx(url, model);
    if (ctx === null) {
      ctx = FALLBACK_CTX;
      log(`context ceiling: assuming ${ctx} tokens; the server does not report one. Set --ctx, DELEGATE_CTX, or "ctx" in ${CONFIG_PATH} to the model's real context size.`);
    } else {
      log(`context ceiling: ${ctx} tokens (reported by the server)`);
    }
  }
  return { model, ctx };
}

/** llama-server reports its context size at /props; behind llama-swap that is /upstream/<model>/props. */
async function probeCtx(url: string, model: string): Promise<number | null> {
  for (const path of ["/props", `/upstream/${encodeURIComponent(model)}/props`]) {
    try {
      const res = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!res.ok) continue;
      const data = (await res.json()) as { default_generation_settings?: { n_ctx?: unknown } };
      const n = data.default_generation_settings?.n_ctx;
      if (typeof n === "number" && n > 0) return n;
    } catch {
      // not a llama-server, or nothing at that path
    }
  }
  return null;
}

interface UserConfig { url?: string; model?: string; ctx?: number }

/** ${CONFIG_PATH}: {"url", "model", "ctx"}, all optional. A typo is refused, like a spec key. */
function loadConfig(): UserConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    die(`cannot read ${CONFIG_PATH}: ${(e as Error).message}`, 4);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) die(`${CONFIG_PATH} must hold a JSON object`, 4);
  const c = raw as Record<string, unknown>;
  const out: UserConfig = {};
  for (const k of Object.keys(c)) {
    const v = c[k];
    if (k === "url" || k === "model") {
      if (typeof v !== "string" || !v) die(`"${k}" in ${CONFIG_PATH} must be a non-empty string`, 4);
      out[k] = v;
    } else if (k === "ctx") {
      if (typeof v !== "number" || !(v > 0)) die(`"ctx" in ${CONFIG_PATH} must be a positive number`, 4);
      out.ctx = v;
    } else {
      die(`unknown key "${k}" in ${CONFIG_PATH}; the keys are url, model, ctx`, 4);
    }
  }
  return out;
}

function numberFlag(flags: Record<string, string | boolean>, name: string, fallback: number): number {
  const v = flags[name] === undefined ? fallback : Number(flags[name]);
  if (!Number.isFinite(v) || v < 0) die(`--${name} must be a number`, 4);
  return v;
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (flags.help || (positional.length === 0 && !flags.ask)) {
    console.log(HELP);
    process.exit(flags.help ? 0 : 4);
  }
  if (flags.ask && positional.length > 0) die(`give either a spec file or --ask, not both`, 4);
  if (flags.log) useLogFile(String(flags.log));

  const spec: TaskSpec & Partial<AskSpec> = flags.ask ? { ask: String(flags.ask) } : loadSpec(positional[0]);
  const root = resolve(String(flags.root ?? spec.root ?? process.cwd()));
  if (!existsSync(root)) die(`root "${root}" does not exist`, 4);
  const config = loadConfig();
  const url = String(flags.url ?? process.env.DELEGATE_URL ?? config.url ?? FALLBACK_URL).replace(/\/+$/, "");
  const modelSetting: string | null = flags.model !== undefined ? String(flags.model)
    : spec.model ?? process.env.DELEGATE_MODEL ?? config.model ?? null;
  const ctxSetting: number | null = flags.ctx !== undefined ? numberFlag(flags, "ctx", 0)
    : process.env.DELEGATE_CTX ? Number(process.env.DELEGATE_CTX)
    : config.ctx ?? null;
  if (ctxSetting !== null && !(ctxSetting > 0)) die(`the context ceiling must be a positive number, got "${flags.ctx ?? process.env.DELEGATE_CTX}"`, 4);
  const lockWait = numberFlag(flags, "lock-wait", DEFAULT_LOCK_WAIT_S);

  if (spec.ask !== undefined) {
    await mainAsk(spec as AskSpec, flags, { root, url, model: modelSetting, ctx: ctxSetting }, lockWait);
    return;
  }
  const passes = expandPasses(spec);
  const maxRetries = numberFlag(flags, "max-retries", DEFAULT_MAX_RETRIES);
  const maxTokens = numberFlag(flags, "max-tokens", DEFAULT_MAX_TOKENS);
  const gateTimeoutS = numberFlag(flags, "gate-timeout", DEFAULT_GATE_TIMEOUT_S);

  // --- The TypeScript gate needs its configs; a custom `verify` gate does not.
  if (passes.some((p) => !p.verify)) {
    if (!existsSync(join(root, "tsconfig.json"))) {
      die(`root "${root}" has no tsconfig.json — point root at a project that has one, or add a "verify" gate to the spec`, 4);
    }
    if (!hasEslintConfig(root)) {
      die(`root "${root}" has no eslint config — add one, or add a "verify" gate to the spec`, 4);
    }
  }

  const wait = await acquireLock(url, "write", root, lockWait);
  const served = await checkServer(url, modelSetting, ctxSetting);
  const workDir = await mkdtemp(join(tmpdir(), "delegate-loop-"));
  const opts: RunOptions = {
    root, url, model: served.model, ctx: served.ctx, maxRetries, maxTokens,
    review: !flags["no-review"],
    allowDirtyGate: Boolean(flags["allow-dirty-gate"]),
    gateTimeoutMs: gateTimeoutS * 1000,
    workDir,
  };

  const started = Date.now();
  const baselineAll = new Map<string, string | null>();
  const results: PassResult[] = [];
  let prevGreenGate: string | null = null;
  try {
    for (const pass of passes) {
      const r = await runPass(pass, opts, baselineAll, prevGreenGate !== null && prevGreenGate === gateLabel(pass));
      results.push(r);
      prevGreenGate = r.green ? r.gate : null;
      if (!r.green) {
        log(`[${r.name}] FAILED — stopping the batch`);
        break;
      }
    }

    // --- Report.
    const elapsed = Math.round((Date.now() - started) / 1000);
    const allGreen = results.length === passes.length && results.every((r) => r.green);
    for (const r of results) {
      const files = r.files.length > 0 ? r.files.map(fileTag).join(",") : "none";
      const asserts = r.asserts.total > 0 ? `${r.asserts.matched}/${r.asserts.total}` : "n/a";
      console.log(
        `SUMMARY: pass=${r.name} status=${r.green ? "green" : "failed"} files=${files} gate=${r.gate} ` +
        `attempts=${r.attempts} asserts=${asserts} review=${r.review} elapsed=${Math.round(r.elapsedMs / 1000)}s` +
        (r.note ? ` note="${r.note}"` : ""),
      );
    }
    for (const r of results) {
      if (r.reviewNotes) {
        const verdict = r.review === "fixed" ? "found and fixed" : "found; fix failed the gate, so the verified version was kept";
        console.log(`REVIEW: pass=${r.name} ${verdict}:\n${r.reviewNotes.split("\n").map((l) => `  ${l}`).join("\n")}`);
      }
    }
    const logNote = flags.log ? ` Log: ${flags.log}` : "";
    const greenCount = results.filter((r) => r.green).length;
    const note = waitNote(wait);
    if (note) console.log(note);
    if (allGreen) {
      console.log(`STATUS: green — ${greenCount}/${passes.length} pass(es) verified in ${elapsed}s. Nothing was committed.${logNote}`);
    } else {
      const failed = results[results.length - 1];
      const reason = failed?.note || `retries exhausted (${failed?.attempts ?? 0} attempts)`;
      console.log(`STATUS: failed — ${reason}. ${greenCount}/${passes.length} pass(es) green after ${elapsed}s.${logNote}`);
      if (failed?.lastErrors) console.log(`\n--- last errors ---\n${truncate(failed.lastErrors, MAX_ERROR_CHARS)}`);
    }
    if (flags.diff) await printDiff(root, baselineAll, results, workDir);
    recordUsage({
      mode: "write", root, status: allGreen ? "green" : "failed", passes: results.length,
      attempts: results.reduce((n, r) => n + r.attempts, 0),
      files: results.flatMap((r) => r.files.map((f) => `${f.path}:${f.lines}`)), elapsed,
      ...(passes.some((p) => p.patch) ? { patch: true } : {}),
      ...(allGreen ? {} : { note: results[results.length - 1]?.note || "retries exhausted" }),
      ...(wait.holder ? { waited: wait.waitedS } : {}),
    });
    process.exit(allGreen ? 0 : 2);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function mainAsk(
  spec: AskSpec,
  flags: Record<string, string | boolean>,
  base: { root: string; url: string; model: string | null; ctx: number | null },
  lockWait: number,
) {
  validateAsk(spec);
  const limits = {
    maxTokens: numberFlag(flags, "max-tokens", spec.maxTokens ?? DEFAULT_MAX_TOKENS),
    readBudget: numberFlag(flags, "read-budget", spec.readBudget ?? DEFAULT_READ_BUDGET),
    maxTurns: numberFlag(flags, "max-turns", spec.maxTurns ?? DEFAULT_MAX_TURNS),
    maxReadChars: numberFlag(flags, "max-read-chars", spec.maxReadChars ?? DEFAULT_MAX_READ_CHARS),
    maxFileBytes: numberFlag(flags, "max-file-bytes", spec.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES),
    toolTurnTokens: numberFlag(flags, "tool-turn-tokens", spec.toolTurnTokens ?? DEFAULT_TOOL_TURN_TOKENS),
    presencePenalty: numberFlag(flags, "presence-penalty", spec.presencePenalty ?? DEFAULT_PRESENCE_PENALTY),
  };
  if (limits.maxTurns < 1) die(`--max-turns must be at least 1`, 4);
  if (limits.maxReadChars < 1) die(`--max-read-chars must be at least 1`, 4);
  if (limits.maxFileBytes < 1) die(`--max-file-bytes must be at least 1`, 4);
  if (limits.toolTurnTokens < 1) die(`--tool-turn-tokens must be at least 1`, 4);

  let question = spec.ask.trim();
  if (flags.stdin) {
    let input = await Bun.stdin.text();
    if (input.length > MAX_STDIN_CHARS) {
      const head = Math.floor(MAX_STDIN_CHARS * 0.6);
      input = `${input.slice(0, head)}\n\n...[truncated: input was ${input.length} chars]...\n\n${input.slice(-(MAX_STDIN_CHARS - head))}`;
    }
    question += `\n\nInput:\n\`\`\`\n${input.trimEnd()}\n\`\`\``;
  }
  const wait = await acquireLock(base.url, "ask", base.root, lockWait);
  const served = await checkServer(base.url, base.model, base.ctx);
  const opts: AskOptions = { ...base, model: served.model, ctx: served.ctx, ...limits };

  const r = await runAsk(question, opts);
  const s = r.state;
  const elapsed = Math.round(r.elapsedMs / 1000);
  const logNote = flags.log ? ` Log: ${flags.log}` : "";
  const extras = [
    r.repeats > 0 ? `${r.repeats} repeated call(s) skipped` : "",
    r.discarded > 0 ? `${r.discarded} turn(s) thrown away` : "",
    r.stalled ? "tool use ended on repeats" : "",
  ].filter(Boolean).map((x) => `, ${x}`).join("");
  const counts = `${r.turns} turn(s), ${s.reads} file(s) read of ${opts.readBudget}, ${s.greps} grep(s), ${s.lists} list(s)${extras}, ${elapsed}s`;
  const note = waitNote(wait);
  if (r.answer !== null) {
    console.log(r.answer);
    console.log("");
    if (s.budgetExhausted) {
      console.log(`WARNING: read budget exhausted at ${opts.readBudget} file(s); the answer covers only the files read. Re-run with --read-budget ${opts.readBudget * 2} or narrow the question.`);
    }
    if (r.truncated) {
      console.log(`WARNING: the answer was cut off at ${opts.maxTokens} tokens. Re-run with --max-tokens ${Math.min(opts.maxTokens * 2, MAX_TOKEN_CEILING)}.`);
    }
    if (r.forced === "turns") {
      console.log(`WARNING: the model used all ${opts.maxTurns} turns and was told to answer with what it had, so part of the question may be unanswered. Ask a narrower question (one topic per ask), or re-run with --max-turns ${opts.maxTurns * 2}.`);
    }
    if (r.forced === "context") {
      console.log(`WARNING: the context filled up before the model finished looking, so it was told to answer with what it had. Ask a narrower question, name the files to grep, or lower --max-read-chars.`);
    }
    if (r.toolsEnded) {
      console.log(`WARNING: the model's tool calls broke twice in a row (runaway or cut off), so tool use ended early. The answer covers only what it had read. A narrower question usually avoids this.`);
    }
    if (note) console.log(note);
    console.log(`STATUS: answered — ${counts}.${logNote}`);
  } else {
    if (note) console.log(note);
    console.log(`STATUS: failed — ${r.note}. ${counts}.${logNote}`);
  }
  recordUsage({
    mode: "ask", root: opts.root, status: r.answer !== null ? "answered" : "failed",
    turns: r.turns, reads: s.reads, greps: s.greps, elapsed,
    // Answer size is what the caller pays in its own tokens; context size is what the model paid.
    ...(r.answer !== null ? { answerChars: r.answer.length } : {}),
    ctxTok: r.contextTokens,
    ...(r.discarded > 0 ? { discarded: r.discarded } : {}),
    ...(r.repeats > 0 ? { repeats: r.repeats } : {}),
    ...(r.stalled ? { stalled: true } : {}),
    ...(r.forced ? { forced: r.forced } : {}),
    ...(wait.holder ? { waited: wait.waitedS } : {}),
    maxTurns: opts.maxTurns,
    // Which questions run long is what the next round of tuning needs to see.
    question: spec.ask.trim().replace(/\s+/g, " ").slice(0, 200),
  });
  process.exit(r.answer !== null ? 0 : 2);
}

async function printDiff(root: string, baseline: Map<string, string | null>, results: PassResult[], workDir: string) {
  const touched = [...new Set(results.flatMap((r) => r.files.map((f) => f.path)))];
  if (touched.length === 0) {
    console.log("\n(no files were written)");
    return;
  }
  console.log("\n--- diff ---");
  for (const p of touched) {
    const abs = resolveWithinRoot(root, p);
    const after = existsSync(abs) ? await readFile(abs, "utf8") : "";
    const d = await unifiedDiff(workDir, p, baseline.get(p) ?? null, after);
    if (d) console.log(d);
  }
}

/** One line per run in ~/.claude/delegate-usage.jsonl, so offloading stays measurable. */
function recordUsage(entry: Record<string, unknown>) {
  try {
    mkdirSync(dirname(USAGE_LOG), { recursive: true });
    appendFileSync(USAGE_LOG, JSON.stringify({ ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), ...entry }) + "\n");
  } catch {
    // never fail a run over bookkeeping
  }
}

// An unexpected throw must still end in a STATUS line: the caller reads only the report.
main().catch((e) => die(`internal error: ${(e as Error)?.message ?? e}`, 1));
