// Ternary Bonsai 2: the dialect, its template, and the prefix the cache needs.
//
// The CAPTURED strings are raw completions from the real 27B (PTQ1_0) on the
// WebGPU kernels, with smolbox's system prompt and generated tool schema,
// exactly as the model worker decodes them (special tokens kept, the prompt's
// opening `<think>\n` not included). PLAN §10.28.
//
// The last block is the one with teeth. This engine's cache cannot be rewound,
// so a turn reuses it only if the new prompt extends the last prompt plus the
// model's completion character for character. That depends on three things
// agreeing — the parser's split, the loop's history, and the GGUF's template —
// and none of them needs a GPU, so it is checked here, against the real
// template text, with a control that shows the flag is what makes it hold.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { openaiTool } from "../../tool.ts";
import { type BonsaiTokenizer, codecFor } from "../bonsai-kernels.ts";
import { Conversation, DEFAULTS } from "../conversation.ts";
import { FakeModelClient } from "../fake-model.ts";
import type { ChatMessage } from "../messages.ts";
import type { GenerateRequest, GenerateResult } from "../model-client.ts";
import { bonsai, parseTurn, preview } from "./bonsai.ts";
import type { Dialect } from "./types.ts";

const CAPTURED_CALL =
  "The user is asking about the number of files in their folder and the largest file. The user's folder is mounted at /mnt/host. Let's check it.\n" +
  "</think>\n\n" +
  "<tool_call>\n<function=run_terminal_command>\n<parameter=cmd>\n" +
  "find /mnt/host -type f | wc -l; echo \"---\"; find /mnt/host -type f -printf '%s %p\\n' | sort -rn | head -5\n" +
  "</parameter>\n</function>\n</tool_call>";

const CAPTURED_ANSWER =
  "The user is asking how many files are in the folder, and which one is the largest. I found 3 files, and the largest is notes.md at 1204 bytes.\n" +
  "</think>\n\n" +
  "Your folder contains **3 files**:\n\n| File | Size |\n|------|------|\n| `notes.md` | 1,204 bytes (largest) |\n| `hello.txt` | 311 bytes |\n| `sub/a.txt` | 42 bytes |\n\n" +
  "The largest file is **`notes.md`** at 1,204 bytes.";

const TEMPLATE = readFileSync("tests/agent/bonsai2-chat-template.jinja", "utf8");

/** The codec over the real template; tokens are irrelevant to rendering. */
const codec = codecFor({
  config: { chat_template: TEMPLATE },
  encode: () => ({ ids: [] }),
  decode: () => "",
} satisfies BonsaiTokenizer);

describe("bonsai parseTurn", () => {
  test("CAPTURED: a call after reasoning the prompt opened", () => {
    const t = parseTurn(CAPTURED_CALL);
    expect(t.calls).toEqual([
      {
        name: "run_terminal_command",
        args: {
          cmd: "find /mnt/host -type f | wc -l; echo \"---\"; find /mnt/host -type f -printf '%s %p\\n' | sort -rn | head -5",
        },
      },
    ]);
    expect(t.reasoning).toStartWith("The user is asking about the number of files");
    expect(t.text).toBe("");
  });

  test("CAPTURED: a final answer after reasoning", () => {
    const t = parseTurn(CAPTURED_ANSWER);
    expect(t.calls).toEqual([]);
    expect(t.reasoning).toEndWith("notes.md at 1204 bytes.");
    expect(t.text).toStartWith("Your folder contains **3 files**");
    expect(t.text).not.toContain("</think>");
  });

  test("mid-thought is reasoning, not the answer", () => {
    const p = preview("The user wants a count, so I will");
    expect(p.text).toBe("");
    expect(p.reasoning).toBe("The user wants a count, so I will");
  });

  test("the call's XML never streams into the log", () => {
    const p = preview(CAPTURED_CALL.slice(0, CAPTURED_CALL.indexOf("<parameter=cmd>") + 20));
    expect(p.pendingCall).toBe(true);
    expect(p.text).not.toContain("<function=");
  });
});

describe("the Bonsai template, rendered with our tools", () => {
  const sys: ChatMessage = { role: "system", content: "You are smolbox." };
  const user: ChatMessage = { role: "user", content: "How many files?" };

  test("carries the tool schema, which the engine's own renderer drops", () => {
    const prompt = codec.render([sys, user], [openaiTool()]);
    expect(prompt).toContain("<tools>");
    expect(prompt).toContain('"name": "run_terminal_command"');
    expect(prompt).toContain("You are smolbox.");
  });

  test("opens the scratchpad for the model", () => {
    expect(codec.render([sys, user], [openaiTool()])).toEndWith("<|im_start|>assistant\n<think>\n");
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

async function prompts(dialect: Dialect): Promise<string[]> {
  const model = new Recording([{ name: "files", turns: [{ text: CAPTURED_CALL }, { text: CAPTURED_ANSWER }] }]);
  const convo = new Conversation(
    { systemPrompt: "You are smolbox.", tools: [openaiTool()], dialect, ...DEFAULTS },
    model,
    { run: async () => ({ text: "exit_code: 0\nstdout:\n3\n---\n1204 /mnt/host/notes.md\n", exitCode: 0 }) },
    () => {},
  );
  await convo.send("How many files are in my folder, and what is the largest one?");
  expect(model.requests).toHaveLength(2);
  return model.requests.map((r) => codec.render(r.messages, r.tools));
}

describe("the prefix the non-rewindable cache depends on", () => {
  test("the second prompt extends the first prompt plus the model's own completion", async () => {
    const [first, second] = await prompts(bonsai);
    expect(second!.startsWith(first! + CAPTURED_CALL)).toBe(true);
  });

  test("control: without replayed reasoning the prefix breaks", async () => {
    // This is the whole reason Dialect.replayReasoning exists. Without it the
    // template renders an empty scratchpad where the model wrote a full one,
    // and the engine has to prefill the entire conversation again.
    const [first, second] = await prompts({ ...bonsai, replayReasoning: false });
    expect(second!.startsWith(first! + CAPTURED_CALL)).toBe(false);
  });
});
