import { describe, expect, test } from "bun:test";

import { type ElementFactory, parseInline, parseMarkdown, renderMarkdown } from "./markdown.ts";

describe("parseInline", () => {
  test("code, strong and em", () => {
    expect(parseInline("a `b` **c** *d* _e_")).toEqual([
      { type: "text", text: "a " },
      { type: "code", text: "b" },
      { type: "text", text: " " },
      { type: "strong", children: [{ type: "text", text: "c" }] },
      { type: "text", text: " " },
      { type: "em", children: [{ type: "text", text: "d" }] },
      { type: "text", text: " " },
      { type: "em", children: [{ type: "text", text: "e" }] },
    ]);
  });

  test("markers inside code are literal", () => {
    expect(parseInline("`**not bold**`")).toEqual([{ type: "code", text: "**not bold**" }]);
  });

  test("snake_case and file_name.txt are not emphasis", () => {
    expect(parseInline("see my_file_name.txt and snake_case_var")).toEqual([
      { type: "text", text: "see my_file_name.txt and snake_case_var" },
    ]);
  });

  test("an unmatched marker mid-stream stays literal", () => {
    expect(parseInline("the size is **8")).toEqual([{ type: "text", text: "the size is **8" }]);
    expect(parseInline("run `ls -la")).toEqual([{ type: "text", text: "run `ls -la" }]);
  });

  test("a lone asterisk with spaces around it is multiplication, not emphasis", () => {
    expect(parseInline("2 * 3 * 4")).toEqual([{ type: "text", text: "2 * 3 * 4" }]);
  });
});

describe("parseMarkdown", () => {
  test("CAPTURED: LFM3's answer — paragraphs, a list, bold and code", () => {
    const blocks = parseMarkdown(
      "In your folder at `/mnt/host`, there is **1 file**:\n\n- `hello.txt`\n\nThe largest file is `hello.txt`.",
    );
    expect(blocks.map((b) => b.type)).toEqual(["p", "list", "p"]);
  });

  test("CAPTURED: Bonsai's table", () => {
    const blocks = parseMarkdown(
      "Your folder contains **3 files**:\n\n| File | Size |\n|------|------|\n| `notes.md` | 1,204 bytes (largest) |\n| `hello.txt` | 311 bytes |\n\nDone.",
    );
    expect(blocks.map((b) => b.type)).toEqual(["p", "table", "p"]);
    const table = blocks[1] as Extract<(typeof blocks)[number], { type: "table" }>;
    expect(table.head).toHaveLength(2);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]![0]).toEqual([{ type: "code", text: "notes.md" }]);
  });

  test("a fenced block keeps its text verbatim, including markdown inside it", () => {
    const blocks = parseMarkdown("```sh\nls **/*.md\n# not a heading\n```");
    expect(blocks).toEqual([{ type: "code", lang: "sh", text: "ls **/*.md\n# not a heading" }]);
  });

  test("an unclosed fence mid-stream runs to the end instead of swallowing nothing", () => {
    expect(parseMarkdown("Here:\n```\nhello from")).toEqual([
      { type: "p", inline: [{ type: "text", text: "Here:" }] },
      { type: "code", lang: "", text: "hello from" },
    ]);
  });

  test("headings, ordered lists, quotes and rules", () => {
    const blocks = parseMarkdown("## Files\n1. one\n2. two\n> quoted\n\n---");
    expect(blocks.map((b) => b.type)).toEqual(["h", "list", "quote", "hr"]);
    expect((blocks[1] as { ordered: boolean }).ordered).toBe(true);
  });

  test("a pipe in prose is not a table without a separator row", () => {
    expect(parseMarkdown("use a | b to pipe").map((b) => b.type)).toEqual(["p"]);
  });

  test("an empty answer is no blocks", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n")).toEqual([]);
  });
});

/** A fake DOM that serialises what it is built into, tags and text only. */
class Node {
  children: Node[] = [];
  textContent: string | null = null;
  className = "";
  attrs: Record<string, string> = {};
  constructor(readonly tag: string) {}
  appendChild(c: Node) {
    this.children.push(c);
    return c;
  }
  replaceChildren(...c: Node[]) {
    this.children = c;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  html(): string {
    const inner = this.textContent ?? this.children.map((c) => c.html()).join("");
    return this.tag === "span" ? inner : `<${this.tag}>${inner}</${this.tag}>`;
  }
}
const doc = { createElement: (tag: string) => new Node(tag) } as unknown as ElementFactory;

describe("renderMarkdown", () => {
  test("builds nodes, never markup: an HTML tag in the answer stays text", () => {
    const root = new Node("div");
    renderMarkdown(doc, root as unknown as Element, "the README says <script>alert(1)</script> **hi**");
    expect(root.html()).toBe("<div><p>the README says <script>alert(1)</script> <strong>hi</strong></p></div>");
    // The script tag above is a text node's content, not a child element.
    const p = root.children[0]!;
    expect(p.children.map((c) => c.tag)).toEqual(["span", "strong"]);
  });

  test("a model's top-level heading lands under the page's own", () => {
    const root = new Node("div");
    renderMarkdown(doc, root as unknown as Element, "# Summary");
    expect(root.children[0]!.tag).toBe("h4");
  });

  test("re-rendering replaces rather than appends", () => {
    const root = new Node("div");
    renderMarkdown(doc, root as unknown as Element, "one");
    renderMarkdown(doc, root as unknown as Element, "one two");
    expect(root.html()).toBe("<div><p>one two</p></div>");
  });
});
