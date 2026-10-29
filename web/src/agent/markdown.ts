// A small markdown reader for the model's answers.
//
// Every model in the registry answers in markdown — bold, inline code, fenced
// blocks, lists, and tables especially — and the log used to show it as
// typed: asterisks, backticks and pipe-drawn tables. This renders the subset
// those answers actually use, and nothing more.
//
// Two rules, both deliberate:
//
//  - **No HTML, ever.** The text is the model's, and the model has just read
//    whatever was in the user's folder. The output is a tree of plain nodes
//    built with createElement and textContent; there is no innerHTML anywhere
//    on this path, so a `<script>` in a README the model quotes is a string.
//    Links are shown as their text, not made clickable, for the same reason.
//  - **Partial input is normal.** It re-renders on every streamed frame, so an
//    unclosed fence, a half-written table or a lone `**` must render as
//    something sensible rather than throw or swallow the rest of the answer.
//
// parseMarkdown is pure and unit-tested; renderMarkdown is the DOM half.

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] };

export type Block =
  | { type: "p"; inline: Inline[] }
  | { type: "h"; level: number; inline: Inline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "table"; head: Inline[][]; rows: Inline[][][] }
  | { type: "quote"; inline: Inline[] }
  | { type: "hr" };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function isTableRow(line: string): boolean {
  return line.includes("|") && line.trim().length > 1;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) {
    s = s.slice(1);
  }
  if (s.endsWith("|") && !s.endsWith("\\|")) {
    s = s.slice(0, -1);
  }
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "`") {
      inCode = !inCode;
      cur += c;
    } else if (c === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    QUOTE.test(line) ||
    RULE.test(line)
  );
}

/** Splits text into blocks. Never throws; any line it does not recognise is prose. */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      // An unclosed fence runs to the end: mid-stream, that is exactly where
      // the code block the model is still writing ends.
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) {
        body.push(lines[i]!);
        i++;
      }
      i++;
      blocks.push({ type: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "h", level: heading[1]!.length, inline: parseInline(heading[2]!) });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const head = splitRow(line).map(parseInline);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]!) && lines[i]!.trim() !== "") {
        rows.push(splitRow(lines[i]!).map(parseInline));
        i++;
      }
      blocks.push({ type: "table", head, rows });
      continue;
    }

    const ordered = ORDERED.test(line);
    if (ordered || BULLET.test(line)) {
      const re = ordered ? ORDERED : BULLET;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = re.exec(lines[i]!);
        if (m) {
          items.push(parseInline(m[1]!));
          i++;
          continue;
        }
        // An indented line continues the item above it.
        const cont = lines[i]!;
        if (cont.trim() !== "" && /^\s{2,}\S/.test(cont) && items.length > 0) {
          items[items.length - 1]!.push({ type: "text", text: ` ${cont.trim()}` });
          i++;
          continue;
        }
        break;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length) {
        const m = QUOTE.exec(lines[i]!);
        if (!m) {
          break;
        }
        body.push(m[1]!);
        i++;
      }
      blocks.push({ type: "quote", inline: parseInline(body.join("\n")) });
      continue;
    }

    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() !== "" && !startsBlock(lines[i]!)) {
      if (isTableRow(lines[i]!) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
        break;
      }
      para.push(lines[i]!);
      i++;
    }
    blocks.push({ type: "p", inline: parseInline(para.join("\n")) });
  }
  return blocks;
}

/** Inline spans: `code`, **strong**, *em* / _em_. Unmatched markers stay literal. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) {
      out.push({ type: "text", text });
      text = "";
    }
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\" && i + 1 < src.length && /[\\`*_|#[\]()>-]/.test(src[i + 1]!)) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      let ticks = 1;
      while (src[i + ticks] === "`") {
        ticks++;
      }
      const fence = "`".repeat(ticks);
      const end = src.indexOf(fence, i + ticks);
      if (end !== -1) {
        flush();
        out.push({ type: "code", text: src.slice(i + ticks, end).replace(/^ (.*) $/s, "$1") });
        i = end + ticks;
        continue;
      }
    }
    if ((c === "*" || c === "_") && src[i + 1] === c) {
      const marker = c + c;
      const end = src.indexOf(marker, i + 2);
      if (end > i + 2) {
        flush();
        out.push({ type: "strong", children: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (c === "*" || c === "_") {
      // `_` inside a word (snake_case, file_name.txt) is not emphasis.
      const wordBefore = i > 0 && /\w/.test(src[i - 1]!);
      const next = src[i + 1];
      // A doubled marker that found no partner above is literal, not an empty `<em>`.
      if (!(c === "_" && wordBefore) && next !== undefined && next !== c && !/\s/.test(next)) {
        let end = i + 1;
        for (; end < src.length; end++) {
          if (src[end] === c && src[end + 1] !== c && !/\s/.test(src[end - 1]!)) {
            if (c === "_" && end + 1 < src.length && /\w/.test(src[end + 1]!)) {
              continue;
            }
            break;
          }
        }
        if (end < src.length) {
          flush();
          out.push({ type: "em", children: parseInline(src.slice(i + 1, end)) });
          i = end + 1;
          continue;
        }
      }
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

/** The one DOM capability the renderer needs, so the tests can hand it a fake. */
export interface ElementFactory {
  createElement(tag: string): Element;
}

function inlineNodes(doc: ElementFactory, parent: Element, spans: Inline[]): void {
  for (const span of spans) {
    let node: Element;
    if (span.type === "text") {
      node = doc.createElement("span");
      node.textContent = span.text;
    } else if (span.type === "code") {
      node = doc.createElement("code");
      node.textContent = span.text;
    } else {
      node = doc.createElement(span.type);
      inlineNodes(doc, node, span.children);
    }
    parent.appendChild(node);
  }
}

/** Builds the blocks into `parent`, replacing what was there. */
export function renderMarkdown(doc: ElementFactory, parent: Element, src: string): void {
  const nodes: Element[] = [];
  for (const block of parseMarkdown(src)) {
    let node: Element;
    switch (block.type) {
      case "p":
      case "quote":
        node = doc.createElement(block.type === "p" ? "p" : "blockquote");
        inlineNodes(doc, node, block.inline);
        break;
      case "h":
        // Answers sit inside a chat bubble; a model's `#` should not out-shout
        // the page's own heading, so everything lands at h4 and below.
        node = doc.createElement(`h${Math.min(6, block.level + 3)}`);
        inlineNodes(doc, node, block.inline);
        break;
      case "code": {
        node = doc.createElement("pre");
        const code = doc.createElement("code");
        code.textContent = block.text;
        if (block.lang) {
          node.setAttribute("data-lang", block.lang);
        }
        node.appendChild(code);
        break;
      }
      case "list":
        node = doc.createElement(block.ordered ? "ol" : "ul");
        for (const item of block.items) {
          const li = doc.createElement("li");
          inlineNodes(doc, li, item);
          node.appendChild(li);
        }
        break;
      case "table": {
        node = doc.createElement("div");
        node.className = "table-wrap";
        const table = doc.createElement("table");
        const thead = doc.createElement("thead");
        const hr = doc.createElement("tr");
        for (const cell of block.head) {
          const th = doc.createElement("th");
          inlineNodes(doc, th, cell);
          hr.appendChild(th);
        }
        thead.appendChild(hr);
        table.appendChild(thead);
        const tbody = doc.createElement("tbody");
        for (const row of block.rows) {
          const tr = doc.createElement("tr");
          for (const cell of row) {
            const td = doc.createElement("td");
            inlineNodes(doc, td, cell);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        node.appendChild(table);
        break;
      }
      case "hr":
        node = doc.createElement("hr");
        break;
    }
    nodes.push(node);
  }
  parent.replaceChildren(...nodes);
}
