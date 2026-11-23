// The browser demo: the app's real window on the demo bridge. Import order matters: setup installs
// `window.aolangai` (and the frozen clock) before the renderer entry renders the window.
import { params } from "./setup.js";
import "../src/renderer/main.js";

/** Resolves once `ready()` holds, re-checking on every change to the page. */
function when(ready: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (ready()) return resolve();
    const watch = new MutationObserver(() => {
      if (!ready()) return;
      watch.disconnect();
      resolve();
    });
    watch.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  });
}

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];

/** The lanes are on screen and every running run shows its latest step (the first poll answered). */
const lanesReady = () => $(".lanes .lane") !== null && $$(".run-row.running .run-step").every((s) => s.textContent !== "running");

/** Puts the window in the scene the query string asks for, then marks the page ready for a screenshot. */
async function playScene(): Promise<void> {
  switch (params.scene) {
    case "setup":
      await when(() => $(".setup-card") !== null);
      break;
    case "needs-you": {
      await when(() => lanesReady() && $("#needs-you") !== null);
      const main = $(".main")!;
      main.scrollTop = main.scrollHeight; // Needs you is the last block: show it with as much above it as fits
      break;
    }
    case "run": {
      await when(lanesReady);
      const id = `#${params.runId ?? 0}`;
      const row = $$(".run-row").find((r) => r.querySelector(".run-id")?.textContent === id);
      const need = $$(".need-text").find((t) => t.textContent?.startsWith(`${id} `));
      (row ?? need)?.click();
      await when(() => $(".detail") === null || $$(".detail .steps li, .detail .hint").some((e) => e.textContent !== "Loading…"));
      break;
    }
    case "map":
    case "map-detail": {
      await when(() => lanesReady() && $$(".view-switch button").length > 0);
      $$(".view-switch button").find((b) => b.textContent === "Map")!.click();
      await when(() => $(".map-node") !== null);
      if (params.scene === "map-detail") {
        $$(".map-node").find((n) => n.querySelector("title")?.textContent === "Personal")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await when(() => $(".map-detail .run-row") !== null);
      }
      break;
    }
    case "settings": {
      await when(() => $(".topbar") !== null && $$(".topbar button").some((b) => b.textContent === "Settings"));
      $$(".topbar button").find((b) => b.textContent === "Settings")!.click();
      await when(() => $(".settings select") !== null);
      break;
    }
    default:
      await when(lanesReady);
  }
  // A task later, so React has committed what the last step caused. Not requestAnimationFrame: headless Chrome under
  // --virtual-time-budget runs no frames until it takes the screenshot.
  setTimeout(() => (document.documentElement.dataset.demoReady = params.scene), 0);
}

void playScene();
