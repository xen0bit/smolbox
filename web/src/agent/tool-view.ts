// How a tool result is shown to the person, as opposed to the model.
//
// The model reads renderResult's text (tests/tool/render-cases.json pins it):
// an `exit_code:` line, any flags and errors, then `<stdout>`/`<stderr>`
// sections. That shape is right for a model and noisy for a person — the card
// already says `exit 0` in its label, and the tags are scaffolding. So the card
// shows the same content split into its parts, and falls back to the rendered
// text verbatim for anything it does not recognise, so nothing a tool returns
// can disappear from the log.

export interface ToolView {
  /** Flags and errors from the header — `timed out`, `error: …` — or empty. */
  notes: string[];
  stdout: string | null;
  stderr: string | null;
  /** The text as rendered, for a shape this did not recognise. */
  raw: string | null;
}

const EXIT_LINE = /^exit_code: -?\d+(?: \[(.*)\])?$/;
const SECTION = /<(stdout|stderr)>\n([\s\S]*?)\n<\/\1>/g;

export function toolView(rendered: string): ToolView {
  const lines = rendered.split("\n");
  const exit = EXIT_LINE.exec(lines[0] ?? "");
  if (!exit) {
    return { notes: [], stdout: null, stderr: null, raw: rendered };
  }
  const notes = exit[1] ? exit[1].split(", ") : [];
  for (const line of lines.slice(1)) {
    if (line === "") {
      break;
    }
    notes.push(line);
  }
  const view: ToolView = { notes, stdout: null, stderr: null, raw: null };
  SECTION.lastIndex = 0;
  for (let m = SECTION.exec(rendered); m !== null; m = SECTION.exec(rendered)) {
    view[m[1] as "stdout" | "stderr"] = m[2]!;
  }
  return view;
}
