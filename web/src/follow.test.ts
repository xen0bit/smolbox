import { describe, expect, test } from "bun:test";

import { FOLLOW_SLACK_PX, Follower, type ScrollBox, atBottom } from "./follow.ts";

/** A scroll container that clamps scrollTop the way a browser does. */
class Box implements ScrollBox {
  private top = 0;
  constructor(
    public scrollHeight: number,
    public readonly clientHeight = 100,
  ) {}
  get scrollTop(): number {
    return this.top;
  }
  set scrollTop(v: number) {
    this.top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight));
  }
  grow(px: number): void {
    this.scrollHeight += px;
  }
}

describe("atBottom", () => {
  test("within the slack counts, beyond it does not", () => {
    const box = new Box(1000);
    box.scrollTop = 900;
    expect(atBottom(box)).toBe(true);
    box.scrollTop = 900 - FOLLOW_SLACK_PX;
    expect(atBottom(box)).toBe(true);
    box.scrollTop = 900 - FOLLOW_SLACK_PX - 1;
    expect(atBottom(box)).toBe(false);
  });

  test("content shorter than the box is always at the bottom", () => {
    expect(atBottom(new Box(50))).toBe(true);
  });
});

describe("Follower", () => {
  test("growth carries a reader who is at the bottom", () => {
    const box = new Box(1000);
    const f = new Follower(box);
    f.update();
    box.grow(40);
    f.onScroll();
    f.update();
    expect(box.scrollTop).toBe(940);
  });

  test("a reader who scrolled up stays put however much arrives", () => {
    const box = new Box(1000);
    const f = new Follower(box);
    f.update();
    box.scrollTop = 300;
    f.onScroll();
    for (let token = 0; token < 50; token++) {
      box.grow(20);
      f.update();
    }
    expect(box.scrollTop).toBe(300);
    expect(f.following).toBe(false);
  });

  test("a wheel tick upward detaches before the next token, not after the scroll event", () => {
    const box = new Box(1000);
    const f = new Follower(box);
    f.update();
    f.onUserScrollUp();
    box.grow(20);
    f.update();
    expect(box.scrollTop).toBe(900);
  });

  test("scrolling back to the bottom re-attaches", () => {
    const changes: boolean[] = [];
    const box = new Box(1000);
    const f = new Follower(box, (on) => changes.push(on));
    box.scrollTop = 200;
    f.onScroll();
    box.scrollTop = 900;
    f.onScroll();
    box.grow(50);
    f.update();
    expect(box.scrollTop).toBe(950);
    expect(changes).toEqual([false, true]);
  });

  test("jump() pins and re-attaches, and reports the change once", () => {
    const changes: boolean[] = [];
    const box = new Box(1000);
    const f = new Follower(box, (on) => changes.push(on));
    f.onUserScrollUp();
    f.jump();
    f.jump();
    expect(box.scrollTop).toBe(900);
    expect(f.following).toBe(true);
    expect(changes).toEqual([false, true]);
  });

  test("the echo of our own pin is not read as the reader scrolling", () => {
    const box = new Box(1000);
    const f = new Follower(box);
    f.update();
    // The browser fires `scroll` for the programmatic write — after more
    // content has already arrived, so the box is momentarily off the bottom.
    box.grow(500);
    f.onScroll();
    expect(f.following).toBe(true);
  });
});
