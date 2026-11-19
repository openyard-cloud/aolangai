import { expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { appState } from "../testing.js";
import { SetupCard } from "./SetupCard.js";

test("with no account yet, the card leads with what the README leads with: quota and sessions of every account; delegating is optional", () => {
  const h = renderToStaticMarkup(createElement(SetupCard, { state: appState({ install: { skill: "missing", shim: "missing", accounts: [] } }), onOpenSettings: () => {} }));
  expect(h).toContain("aolangai shows the quota and the open Claude Code sessions of every account you add");
  expect(h).toMatch(/Delegating work[^<]*is optional/);
  expect(h).not.toContain("watching and steering");
});
