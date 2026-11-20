import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// The website allows its inline scripts by their SHA-256 hashes, not with 'unsafe-inline'. Editing a script changes
// its hash: this test names the hash to put in the page's Content-Security-Policy. The only other source allowed is
// Cloudflare Web Analytics, whose script Cloudflare adds to index.html when it serves the page.

const root = dirname(fileURLToPath(import.meta.url));

function policyOf(html: string): string {
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html);
  if (!m) throw new Error("no Content-Security-Policy meta tag");
  return m[1]!;
}

const directive = (policy: string, name: string) =>
  policy
    .split(";")
    .map((d) => d.trim().split(/\s+/))
    .find(([n]) => n === name)
    ?.slice(1);

const ANALYTICS_SCRIPT = "https://static.cloudflareinsights.com";
const ANALYTICS_REPORT = "'self'"; // the beacon reports to /cdn-cgi/rum on the same host

const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

for (const page of ["site/index.html", "site/privacy.html"]) {
  test(`${page}: script-src lists exactly the hashes of its inline scripts, and never 'unsafe-inline' or 'unsafe-eval'`, () => {
    const html = readFileSync(join(root, page), "utf8");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => sha256(m[1]!));
    // a script with attributes (src, type, nonce) would slip past the list above
    expect(html.match(/<script\b[^>]*>/g)?.filter((tag) => tag !== "<script>") ?? []).toEqual([]);
    // an inline event handler (onclick=…) is an inline script too, and hashes do not cover it
    expect(html.match(/<[a-z][^>]*\son[a-z]+\s*=/gi) ?? []).toEqual([]);
    const policy = policyOf(html);
    const allowed = directive(policy, "script-src") ?? [];
    expect(allowed.filter((s) => s.startsWith("'unsafe-"))).toEqual([]);
    const analytics = page === "site/index.html" ? [ANALYTICS_SCRIPT] : [];
    expect(allowed.slice().sort()).toEqual([...scripts, ...analytics].sort());
    expect(directive(policy, "connect-src")).toEqual(page === "site/index.html" ? [ANALYTICS_REPORT] : undefined);
    if (scripts.length === 0) expect(directive(policy, "default-src")).toEqual(["'none'"]);
  });
}
