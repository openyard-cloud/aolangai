import { expect, test } from "vitest";
import { attachPanel } from "./panel.js";

function setup() {
  const calls: string[] = [];
  let listener: ((key: string) => void) | undefined;
  const target = { focus: () => void calls.push("focus target") };
  const opener = { focus: () => void calls.push("focus opener") };
  let onClose: () => void = () => void calls.push("close v1");
  const detach = attachPanel({
    target,
    opener,
    onEscape: () => onClose(), // what RunDetail passes: the latest handler, read through a ref
    listen: (cb) => {
      listener = cb;
      return () => void (listener = undefined);
    },
  });
  return { calls, press: (k: string) => listener?.(k), setOnClose: (f: () => void) => (onClose = f), detach, attached: () => listener !== undefined };
}

test("focus the panel once on attach; a parent re-render only swaps the handler, it never focuses again", () => {
  const s = setup();
  expect(s.calls).toEqual(["focus target"]);
  for (let i = 2; i <= 5; i++) s.setOnClose(() => void s.calls.push(`close v${i}`)); // five more renders of the parent
  expect(s.calls).toEqual(["focus target"]);
  s.press("Escape");
  expect(s.calls).toEqual(["focus target", "close v5"]);
});

test("only Escape closes", () => {
  const s = setup();
  s.press("Enter");
  s.press("a");
  expect(s.calls).toEqual(["focus target"]);
});

test("detach stops listening and gives focus back to what opened the panel", () => {
  const s = setup();
  s.detach();
  expect(s.attached()).toBe(false);
  expect(s.calls).toEqual(["focus target", "focus opener"]);
});

test("no opener or no target is fine", () => {
  const detach = attachPanel({ target: null, opener: null, onEscape: () => {}, listen: () => () => {} });
  expect(() => detach()).not.toThrow();
});
