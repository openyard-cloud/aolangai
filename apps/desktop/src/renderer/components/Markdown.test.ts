import { test, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown.js";

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text, onOpenLink: () => {} }));

test("basic markdown and GFM tables", () => {
  expect(html("**bold** and `x`")).toContain("<strong>bold</strong>");
  expect(html("**bold** and `x`")).toContain("<code>x</code>");
  expect(html("|a|b|\n|-|-|\n|1|2|")).toContain("<table>");
});

test("raw HTML in agent output does not become real tags", () => {
  const out = html('before <script>alert(1)</script> <img src=x onerror="alert(1)"> <iframe src="https://x"></iframe> after');
  expect(out).not.toMatch(/<script|<img|<iframe|onerror=/i);
  expect(out).toContain("before");
});

test("images are not fetched: only the alt text shows", () => {
  const out = html("![architecture diagram](https://example.com/a.png)");
  expect(out).not.toContain("<img");
  expect(out).toContain("architecture diagram");
});

test("a javascript: link loses its href; an http link is kept to open outside", () => {
  expect(html("[click](javascript:alert(1))")).not.toContain("javascript:");
  expect(html("[docs](https://example.com)")).toContain('href="https://example.com"');
});

test("a code block is a monospace pre with a Copy button", () => {
  const out = html("```ts\nconst a = 1;\n```");
  expect(out).toContain("<pre");
  expect(out).toContain("const a = 1;");
  expect(out).toContain("Copy");
});
