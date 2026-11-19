#!/usr/bin/env node
// node:sqlite prints an ExperimentalWarning when it is first imported, which would land in the caller's tool output on
// every run. Replace the default warning printer before the module that imports it is loaded; other warnings still print.
process.removeAllListeners("warning");
// The shim runs this file on the app's Electron binary with ELECTRON_RUN_AS_NODE=1; it must not reach the claude
// processes this one starts (an Electron claude would run as plain node).
delete process.env.ELECTRON_RUN_AS_NODE;
// Named: the test of this file waits for this listener before it emits a warning of its own.
process.on("warning", function printWarning(w) {
  if (w.name === "ExperimentalWarning") return;
  process.stderr.write(`(node:${process.pid}) ${w.name}: ${w.message}\n`);
});

// A caller that closed the pipe early must not turn a finished run into a crash.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

const { main } = await import("./main.js");
const code = await main(process.argv.slice(2));
const flush = (s: NodeJS.WriteStream) => new Promise<void>((resolve) => s.write("", () => resolve()));
await Promise.all([flush(process.stdout), flush(process.stderr)]);
process.exit(code);
