import { expect, test } from "vitest";
import { DESKTOP_KIND as CORE_DESKTOP_KIND, OTHER_KIND as CORE_OTHER_KIND } from "@aolangai/core";
import { DESKTOP_KIND, OTHER_KIND } from "../shared/api.js";

// The renderer must not import values from core, so the shared constants are duplicates of core's; they have to agree.
test("the shared host kinds equal core's", () => {
  expect(DESKTOP_KIND).toBe(CORE_DESKTOP_KIND);
  expect(OTHER_KIND).toBe(CORE_OTHER_KIND);
});
