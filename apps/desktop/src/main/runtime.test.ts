import { expect, test } from "vitest";
import { cliPaths, cliRuntime } from "./runtime.js";

const APP = "/Applications/aolangai.app/Contents/MacOS/aolangai";

test("packaged: the app's own binary as node, even when a node is installed", () => {
  expect(cliRuntime({ packaged: true, execPath: APP, node: "/usr/local/bin/node" })).toEqual({ execPath: APP, electron: true });
});

test("not packaged with a node on the machine: that node", () => {
  expect(cliRuntime({ packaged: false, execPath: "/repo/node_modules/electron/dist/Electron", node: "/usr/local/bin/node" })).toEqual({ execPath: "/usr/local/bin/node", electron: false });
});

test("not packaged without a node: the electron binary as node", () => {
  expect(cliRuntime({ packaged: false, execPath: "/repo/node_modules/electron/dist/Electron", node: null })).toEqual({ execPath: "/repo/node_modules/electron/dist/Electron", electron: true });
});

test("cliPaths packaged: the command shipped in the app's Resources/cli", () => {
  expect(cliPaths({ packaged: true, resourcesPath: "/Applications/aolangai.app/Contents/Resources", devRoot: "/repo/packages/cli" })).toEqual({
    entry: "/Applications/aolangai.app/Contents/Resources/cli/dist/index.js",
    skillFile: "/Applications/aolangai.app/Contents/Resources/cli/skill/SKILL.md",
  });
});

test("cliPaths not packaged: the @aolangai/cli workspace package", () => {
  expect(cliPaths({ packaged: false, resourcesPath: "/repo/node_modules/electron/dist/Electron.app/Contents/Resources", devRoot: "/repo/packages/cli" })).toEqual({
    entry: "/repo/packages/cli/dist/index.js",
    skillFile: "/repo/packages/cli/skill/SKILL.md",
  });
});
