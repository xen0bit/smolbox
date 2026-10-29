import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { toolView } from "./tool-view.ts";

// The same table both renderers are held to, so a rendering rule added there is
// a case here before anyone has to remember this file exists.
const cases = (JSON.parse(readFileSync("tests/tool/render-cases.json", "utf8")) as {
  cases: { name: string; want: string }[];
}).cases;

describe("toolView over every pinned rendering", () => {
  for (const c of cases) {
    test(`${c.name}: no content is lost`, () => {
      const v = toolView(c.want);
      if (v.raw !== null) {
        expect(v.raw).toBe(c.want);
        return;
      }
      // Everything inside a section, and every header note, survives the split.
      for (const part of [v.stdout, v.stderr, ...v.notes]) {
        if (part) {
          expect(c.want).toContain(part);
        }
      }
      expect(c.want.includes("<stdout>")).toBe(v.stdout !== null);
      expect(c.want.includes("<stderr>")).toBe(v.stderr !== null);
    });
  }
});

describe("toolView", () => {
  test("splits streams and drops the scaffolding", () => {
    expect(toolView("exit_code: 0\n\n<stdout>\nout\n</stdout>\n\n<stderr>\nerr\n</stderr>\n")).toEqual({
      notes: [],
      stdout: "out",
      stderr: "err",
      raw: null,
    });
  });

  test("flags and errors become notes", () => {
    expect(toolView("exit_code: 137 [timed out, output truncated]\n\n<stdout>\npartial\n</stdout>\n").notes).toEqual([
      "timed out",
      "output truncated",
    ]);
    expect(toolView("exit_code: 1\nerror: chdir /nope: no such file or directory\n").notes).toEqual([
      "error: chdir /nope: no such file or directory",
    ]);
  });

  test("a registry refusal, which is not a rendered result, is shown as it came", () => {
    expect(toolView("error: unknown tool frobnicate").raw).toBe("error: unknown tool frobnicate");
  });
});
