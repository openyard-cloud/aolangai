// electron-builder afterPack hook: ad-hoc sign the packed app ("-" identity, no certificate, no keychain), since the
// config sets mac.identity to null so electron-builder itself never searches the keychain. Renaming the Electron binary
// and editing Info.plist breaks Electron's own signature, and arm64 macOS refuses to run unsigned code.
import { execFileSync } from "node:child_process";
import path from "node:path";

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
}
