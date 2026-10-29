// Stick-to-bottom scrolling for a log that grows while someone reads it.
//
// Both the chat log and the terminal used to set `scrollTop = scrollHeight` on
// every append. During a streamed answer that is every token, so a reader who
// scrolled up to look at a tool result was thrown back to the bottom a few
// dozen times a second, and the only way to read anything above the live turn
// was to wait for the turn to end.
//
// The rule now is the one chat apps converged on: follow the bottom only while
// the reader is already there. Scrolling up detaches; scrolling back down to
// the bottom, or asking to (the "jump to latest" button, sending a message),
// re-attaches. Growth never moves a detached reader.
//
// Pure apart from the box it is handed, so the rule is unit-tested under bun
// with a fake box rather than only reachable through a browser.

/** How close to the bottom still counts as "at the bottom", in CSS pixels. */
export const FOLLOW_SLACK_PX = 32;

/** The three numbers the rule needs from a scroll container. */
export interface ScrollBox {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** Whether `box` is scrolled to (within `slack` of) its bottom. */
export function atBottom(box: ScrollBox, slack: number = FOLLOW_SLACK_PX): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= slack;
}

export class Follower {
  private attached = true;
  // The scrollTop this object last wrote. A scroll event that lands there is
  // our own echo, not the reader, and must not be read as intent either way.
  private wrote: number | null = null;

  constructor(
    private readonly box: ScrollBox,
    private readonly onChange: (following: boolean) => void = () => {},
  ) {}

  /** Whether growth currently carries the view with it. */
  get following(): boolean {
    return this.attached;
  }

  /** After content changed: keep the bottom in view, if the reader is there. */
  update(): void {
    if (this.attached) {
      this.pin();
    }
  }

  /** The reader asked for the bottom — the button, or sending a message. */
  jump(): void {
    this.pin();
    this.set(true);
  }

  /** The container's `scroll` event. */
  onScroll(): void {
    if (this.wrote !== null && Math.abs(this.box.scrollTop - this.wrote) < 1) {
      return;
    }
    this.wrote = null;
    this.set(atBottom(this.box));
  }

  /**
   * An unambiguous gesture upward — a wheel tick or a key press.
   *
   * Detaches before the next token arrives. Waiting for the `scroll` event is
   * not enough on its own: a token can land between the gesture and the event,
   * and its update() would yank the view straight back, which is the bug this
   * file exists to fix.
   */
  onUserScrollUp(): void {
    this.wrote = null;
    this.set(false);
  }

  private pin(): void {
    this.box.scrollTop = this.box.scrollHeight;
    this.wrote = this.box.scrollTop;
  }

  private set(following: boolean): void {
    if (following !== this.attached) {
      this.attached = following;
      this.onChange(following);
    }
  }
}

/** Keys that move a focused scroll container upward. */
export const SCROLL_UP_KEYS: ReadonlySet<string> = new Set(["ArrowUp", "PageUp", "Home"]);
