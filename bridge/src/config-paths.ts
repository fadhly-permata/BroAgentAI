import os from "node:os";
import path from "node:path";
import type { Platform } from "@browseragent/shared";

export function currentPlatform(): Platform {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

export function resolveConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.BROWSERAGENT_CONFIG_DIR?.trim();
  if (override) return path.resolve(override);

  if (platform === "win32") {
    const appData = env.APPDATA?.trim() || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "BrowserAgent");
  }

  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "BrowserAgent");
  }

  const xdg = env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(xdg, "browseragent");
}

export function configPathFor(configDir: string): string {
  return path.join(configDir, "config.json");
}

export function logPathFor(configDir: string): string {
  return path.join(configDir, "logs", "host.log");
}

export function allowedOriginsPathFor(configDir: string): string {
  return path.join(configDir, "allowed-origins.json");
}
