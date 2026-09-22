#!/usr/bin/env bun
/**
 * Mock llama-swap for deterministic tests of delegate-loop.ts.
 *
 * Usage: mock-llama.ts <replies-dir> <port> [requests.jsonl]
 *
 * Serves /v1/models (two ids, like a llama-swap with two entries; the tests pick one
 * through DELEGATE_MODEL), /props (n_ctx 98304, like llama-server) and /v1/chat/completions.
 * Each chat request streams the next scripted reply from <replies-dir>:
 *   N.txt         plain content, finish_reason "stop"
 *   N.length.txt  plain content, finish_reason "length" (a truncated reply)
 *   N.tool.json   a JSON array of {name, arguments} streamed as tool_calls deltas;
 *                 {name, raw} sends raw as the arguments text (a half-written call)
 *   N.tool.length.json  the same, but finish_reason "length" (a runaway turn cut off)
 * Every request is appended to requests.jsonl as
 * {"model": id, "max_tokens": n, "presence_penalty": n, "messages": [...], "tools": n},
 * one per line, so a test can check what the loop actually sent.
 * MOCK_DELAY_MS delays every chat reply, so a test can overlap two runs.
 */
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [dir, portArg, requestsPath] = process.argv.slice(2);
if (!dir || !portArg) {
  console.error("usage: mock-llama.ts <replies-dir> <port> [requests.jsonl]");
  process.exit(4);
}

interface Reply {
  content: string;
  finish: string;
  calls?: { name: string; arguments?: unknown; raw?: string }[];
}

const replies: Reply[] = readdirSync(dir)
  .map((f) => ({ f, m: /^(\d+)(?:\.(length|tool|tool\.length))?\.(txt|json)$/.exec(f) }))
  .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null)
  .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
  .map(({ f, m }) => {
    const raw = readFileSync(join(dir, f), "utf8");
    if (m[2] === "tool") return { content: "", finish: "tool_calls", calls: JSON.parse(raw) };
    if (m[2] === "tool.length") return { content: "", finish: "length", calls: JSON.parse(raw) };
    return { content: raw, finish: m[2] === "length" ? "length" : "stop" };
  });

let next = 0;
const delayMs = Number(process.env.MOCK_DELAY_MS ?? 0);
const enc = new TextEncoder();
const chunk = (delta: unknown, finish: string | null = null) =>
  enc.encode(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`);

Bun.serve({
  port: Number(portArg),
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/props") {
      return Response.json({ default_generation_settings: { n_ctx: 98304 } });
    }
    if (pathname === "/v1/models") {
      return Response.json({ data: [{ id: "qwen3.8-27b-delegate" }, { id: "qwen3.8-27b-chat" }] });
    }
    if (pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });

    const body = (await req.json()) as { model?: string; messages: unknown; tools?: unknown[]; max_tokens?: number; presence_penalty?: number };
    if (requestsPath) {
      appendFileSync(requestsPath, JSON.stringify({
        model: body.model, max_tokens: body.max_tokens, presence_penalty: body.presence_penalty ?? null,
        messages: body.messages, tools: body.tools?.length ?? 0,
      }) + "\n");
    }
    if (delayMs > 0) await Bun.sleep(delayMs);
    const r = replies[next++] ?? { content: "(mock: out of scripted replies)", finish: "stop" };
    const stream = new ReadableStream({
      start(c) {
        if (r.calls) {
          // Like llama.cpp: id + name + the first byte of arguments, then the rest in pieces.
          r.calls.forEach((call, index) => {
            const args = call.raw ?? JSON.stringify(call.arguments ?? {});
            c.enqueue(chunk({ tool_calls: [{ index, id: `mock_${next}_${index}`, type: "function", function: { name: call.name, arguments: args.slice(0, 1) } }] }));
            const half = Math.ceil(args.length / 2);
            for (const piece of [args.slice(1, half), args.slice(half)]) {
              c.enqueue(chunk({ tool_calls: [{ index, function: { arguments: piece } }] }));
            }
          });
        } else {
          // Two chunks, so the client's line-splitting path is exercised too.
          const half = Math.ceil(r.content.length / 2);
          for (const piece of [r.content.slice(0, half), r.content.slice(half)]) c.enqueue(chunk({ content: piece }));
        }
        c.enqueue(chunk({}, r.finish));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  },
});
console.log(`mock llama-swap on :${portArg} with ${replies.length} scripted reply(ies)`);
