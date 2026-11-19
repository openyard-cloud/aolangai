import type { AolangaiBridge } from "../shared/api";

declare global {
  interface Window {
    aolangai: AolangaiBridge;
  }
}
export {};
