import { existsSync } from "node:fs";

import type { EnvironmentInfo } from "./rpc.ts";

interface DiscoverOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  refresh?: boolean;
}

const SECRET_KEY = /(token|password|secret|api[_-]?key|authorization|credential)/i;
let cache: EnvironmentInfo | null = null;

function pathSourceFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): "PATH" | "Path" | "none" {
  if (platform === "win32" && typeof env.Path === "string") return "Path";
  if (typeof env.PATH === "string") return "PATH";
  return "none";
}

function isAbsoluteEntry(entry: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(entry) || entry.startsWith("\\\\");
  return entry.startsWith("/");
}

export function discoverEnvironment(options: DiscoverOptions = {}): EnvironmentInfo {
  const custom = options.env !== undefined || options.platform !== undefined || options.exists !== undefined;
  if (!custom && !options.refresh && cache) return cache;

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const source = pathSourceFor(platform, env);
  const raw = source === "none" ? "" : env[source] ?? "";
  const delimiter = platform === "win32" ? ";" : ":";
  const entries = raw.split(delimiter).map((entry) => entry.trim()).filter(Boolean);

  let absolute = 0;
  let relative = 0;
  let missing = 0;
  for (const entry of entries) {
    if (isAbsoluteEntry(entry, platform)) absolute += 1;
    else relative += 1;
    if (!exists(entry)) missing += 1;
  }

  const info: EnvironmentInfo = {
    pathSource: source,
    pathOrigin: entries.length > 0 ? "inherited" : "none",
    pathEntryCount: entries.length,
    pathEntryKinds: { absolute, relative, missing },
    profilePolicy: "no-profile",
    shellProfilesLoaded: false,
    credentialKeysDetected: Object.keys(env).filter((key) => SECRET_KEY.test(key)).length,
    credentialsExposed: false,
  };

  if (!custom) cache = info;
  return info;
}

export function refreshEnvironment(): EnvironmentInfo {
  return discoverEnvironment({ refresh: true });
}
