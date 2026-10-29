// LFM3: the dialect, its template, and the prefix the cache needs.
//
// The CAPTURED strings are raw completions from the real LFM3-1.7B (Q4_K_M) on
// the WebGPU kernels, with smolbox's system prompt and generated tool schema,
// exactly as the model worker decodes them (special tokens kept, the prompt's
// opening `<think>` not included). Two questions in one chat, against the e2e
// mount fixture. PLAN §10.30.
//
// The last two blocks are the ones with teeth. The KernelEngine reuses its
// cache only when the new prompt extends the last prompt plus the model's
// completion, so a tool round trip costs a prefill of the tool result rather
// than of the whole conversation. That depends on the loop's history, the
// codec's rewrite and the GGUF's template agreeing, and none of them needs a GPU,
// so it is checked here against the real template text, with a control for
// each half of the rewrite.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { openaiTool } from "../../tool.ts";
import { Conversation, DEFAULTS } from "../conversation.ts";
import { FakeModelClient } from "../fake-model.ts";
import { LFM3_TEMPLATE_ARGS, lfm3Codec, prepareHistory, wrapSession } from "../lfm3-kernels.ts";
import type { ChatMessage } from "../messages.ts";
import type { GenerateRequest, GenerateResult } from "../model-client.ts";
import { type GgufTokenizer, codecFor } from "../prompt-codec.ts";
import { lfm3, parseTurn, preview } from "./lfm3.ts";

const CALL =
  "The user is asking about their folder. The user's folder is mounted read-only at /mnt/host. I need to inspect it before answering. Let me list the files in /mnt/host. I'll use `ls -la` or `find`. Let me start with `ls -la /mnt/host`.</think>" +
  "<tool_call>\n<function=run_terminal_command>\n<parameter=cmd>\nls -la /mnt/host\n</parameter>\n</function>\n</tool_call>";

const ANSWER =
  "So there is 1 file in the folder (only regular file `hello.txt`). The largest is `hello.txt` with size 8286623314361712661 bytes.\n\n" +
  "Let me answer: There is 1 file in the folder, and the largest is `hello.txt` (size 8286623314361712661 bytes).\n\n" +
  "I'll mention that `link.txt` is a symlink and `sub` is a directory, so they aren't counted as files.</think>" +
  "In your folder at `/mnt/host`, there is **1 file**:\n\n- `hello.txt`\n\n" +
  "The largest file is `hello.txt`, with a size of **8,286,623,314,361,712,661 bytes** (~8.2 exabytes).\n\n" +
  "Note: `link.txt` is a symlink pointing to `hello.txt`, and `sub` is a directory, so they aren't counted as regular files.";

const FOLLOW_UP_CALL =
  "The user asks what hello.txt says. I need to read the file. It's at /mnt/host/hello.txt. Use cat or read. Let me run `cat /mnt/host/hello.txt`.</think>" +
  "<tool_call>\n<function=run_terminal_command>\n<parameter=cmd>\ncat /mnt/host/hello.txt\n</parameter>\n</function>\n</tool_call>";

const FOLLOW_UP_ANSWER =
  'The content is "hello from the mount". Let me answer.</think>`hello.txt` contains the following text:\n\n```\nhello from the mount\n```';

const TEMPLATE = readFileSync("tests/agent/lfm3-chat-template.jinja", "utf8");

const tokenizer: GgufTokenizer = {
  config: { chat_template: TEMPLATE, bos_token: "<|startoftext|>", eos_token: "<|im_end|>" },
  encode: () => ({ ids: [] }),
  decode: () => "",
};

const codec = lfm3Codec(tokenizer);

describe("lfm3 parseTurn", () => {
  test("CAPTURED: a call after reasoning the prompt opened", () => {
    const t = parseTurn(CALL);
    expect(t.calls).toEqual([{ name: "run_terminal_command", args: { cmd: "ls -la /mnt/host" } }]);
    expect(t.reasoning).toStartWith("The user is asking about their folder.");
    expect(t.reasoning).toEndWith("Let me start with `ls -la /mnt/host`.");
    expect(t.text).toBe("");
  });

  test("CAPTURED: a final answer after reasoning", () => {
    const t = parseTurn(ANSWER);
    expect(t.calls).toEqual([]);
    expect(t.reasoning).toEndWith("so they aren't counted as files.");
    expect(t.text).toStartWith("In your folder at `/mnt/host`");
    expect(t.text).not.toContain("</think>");
  });

  test("CAPTURED: the follow-up's call and answer", () => {
    expect(parseTurn(FOLLOW_UP_CALL).calls).toEqual([
      { name: "run_terminal_command", args: { cmd: "cat /mnt/host/hello.txt" } },
    ]);
    expect(parseTurn(FOLLOW_UP_ANSWER).text).toBe("`hello.txt` contains the following text:\n\n```\nhello from the mount\n```");
  });

  test("mid-thought is reasoning, not the answer", () => {
    const p = preview("The user wants a listing, so I");
    expect(p.text).toBe("");
    expect(p.reasoning).toBe("The user wants a listing, so I");
  });

  test("the call's XML never streams into the log", () => {
    const p = preview(CALL.slice(0, CALL.indexOf("<parameter=cmd>") + 20));
    expect(p.pendingCall).toBe(true);
    expect(p.text).not.toContain("<function=");
  });
});

describe("the LFM3 template, rendered with our tools", () => {
  const sys: ChatMessage = { role: "system", content: "You are smolbox." };
  const user: ChatMessage = { role: "user", content: "What is in my folder?" };

  test("carries the tool schema, which the engine's own renderer drops", () => {
    const prompt = codec.render([sys, user], [openaiTool()]);
    expect(prompt).toStartWith("<|startoftext|><|im_start|>system\nYou are smolbox.\n\n<tools>\n");
    expect(prompt).toContain('"name": "run_terminal_command"');
  });

  test("opens the scratchpad for the model, with no newline after it", () => {
    expect(codec.render([sys, user], [openaiTool()])).toEndWith("<|im_start|>assistant\n<think>");
  });

  test("a tool result is wrapped by the template, not by us", () => {
    const prompt = codec.render(
      [sys, user, { role: "assistant", content: CALL }, { role: "tool", content: "exit_code: 0" }],
      [openaiTool()],
    );
    expect(prompt).toContain("<|im_start|>tool\n<tool_response>\nexit_code: 0\n</tool_response><|im_end|>\n");
  });
});

describe("prepareHistory", () => {
  test("restores the opening tag on a turn that closed its scratchpad", () => {
    expect(prepareHistory([{ role: "assistant", content: ANSWER }])[0]!.content).toBe(`<think>${ANSWER}`);
  });

  test("leaves a turn that never closed it, which the template pads itself", () => {
    const cut = { role: "assistant" as const, content: "still thinking about" };
    expect(prepareHistory([cut])[0]).toBe(cut);
  });

  test("never doubles a tag that is already there, and touches no other role", () => {
    const msgs: ChatMessage[] = [
      { role: "assistant", content: `<think>${ANSWER}` },
      { role: "user", content: "a</think>b" },
    ];
    expect(prepareHistory(msgs)).toEqual(msgs);
  });
});

/** A FakeModelClient that also keeps every request it was handed. */
class Recording extends FakeModelClient {
  requests: GenerateRequest[] = [];
  override generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push({ ...req, messages: structuredClone(req.messages) });
    return super.generate(req);
  }
}

/** Two user turns — a tool round trip, then a follow-up — rendered as the worker would. */
async function prompts(render: (messages: ChatMessage[], tools: unknown[]) => string): Promise<string[]> {
  const model = new Recording([
    { name: "files", when: "folder", turns: [{ text: CALL }, { text: ANSWER }] },
    { name: "follow-up", when: "hello.txt", turns: [{ text: FOLLOW_UP_CALL }, { text: FOLLOW_UP_ANSWER }] },
  ]);
  const convo = new Conversation(
    { systemPrompt: "You are smolbox.", tools: [openaiTool()], dialect: lfm3, ...DEFAULTS },
    model,
    { run: async () => ({ text: "exit_code: 0\n\n<stdout>\nhello.txt\n</stdout>\n", exitCode: 0 }) },
    () => {},
  );
  await convo.send("What is in my folder?");
  await convo.send("What does hello.txt say?");
  expect(model.requests).toHaveLength(4);
  return model.requests.map((r) => render(r.messages, r.tools));
}

describe("the prefix the cache depends on", () => {
  test("each prompt extends the last prompt plus the model's own completion", async () => {
    const [first, second, third, fourth] = await prompts(codec.render);
    expect(second!.startsWith(first! + CALL)).toBe(true);
    expect(third!.startsWith(second! + ANSWER)).toBe(true);
    expect(fourth!.startsWith(third! + FOLLOW_UP_CALL)).toBe(true);
  });

  test("control: without the restored <think>, the tool round trip re-prefills everything", async () => {
    const bare = codecFor(tokenizer, { templateArgs: LFM3_TEMPLATE_ARGS });
    const [first, second] = await prompts(bare.render);
    expect(second!.startsWith(first! + CALL)).toBe(false);
  });

  test("control: without preserve_thinking, the next user message rewrites the last turn", async () => {
    // The template's default drops every scratchpad before the latest user
    // message, so the second question would change the middle of the prompt.
    const forgetful = codecFor(tokenizer, { prepare: prepareHistory });
    const [, second, third] = await prompts(forgetful.render);
    expect(third!.startsWith(second! + ANSWER)).toBe(false);
  });
});

describe("wrapSession", () => {
  test("hands the engine's tuned decode depth to every forward pass", async () => {
    const seen: unknown[] = [];
    const engine = wrapSession({
      model: {
        async *streamTokenIdsFromCache(opts) {
          seen.push(opts.decode_pipeline_depth);
          yield 7;
        },
      },
      generationState: { cache: { truncate: () => {} } },
      eosTokenIds: [2],
      tokenizer,
      decodePipelineDepth: 12,
      deviceInfo: () => ({ vendor: "v", architecture: "a", features: { shaderF16: false, subgroups: true, subgroupMatrix: false } }),
      reset: () => {},
      dispose: () => Promise.resolve(),
    });
    const ids: number[] = [];
    for await (const id of engine.stream([1, 2, 3], 4, () => false)) {
      ids.push(id);
    }
    expect(ids).toEqual([7]);
    expect(seen).toEqual([12]);
    expect(engine.info()).toBe("v a (subgroups)");
  });
});
