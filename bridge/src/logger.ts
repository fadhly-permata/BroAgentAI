import fs from "node:fs";
import path from "node:path";
import type { LogLevel } from "@browseragent/shared";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_ROTATIONS = 3;

export class Logger {
  private level: LogLevel = "info";
  private readonly filePath: string;

  constructor(filePath: string, level: LogLevel = "info") {
    this.filePath = filePath;
    this.level = level;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch {
      return;
    }
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  error(message: string, details?: unknown): void {
    this.write("error", message, details);
  }

  warn(message: string, details?: unknown): void {
    this.write("warn", message, details);
  }

  info(message: string, details?: unknown): void {
    this.write("info", message, details);
  }

  debug(message: string, details?: unknown): void {
    this.write("debug", message, details);
  }

  private write(level: LogLevel, message: string, details?: unknown): void {
    if (LEVEL_WEIGHT[level] > LEVEL_WEIGHT[this.level]) return;

    const suffix = details === undefined ? "" : ` ${safeStringify(details)}`;
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}`;

    try {
      process.stderr.write(`${line}\n`);
    } catch {
      return;
    }

    try {
      this.rotateIfNeeded();
      fs.appendFileSync(this.filePath, `${line}\n`, "utf8");
    } catch {
      return;
    }
  }

  private rotateIfNeeded(): void {
    let stats: fs.Stats;
    try {
      stats = fs.statSync(this.filePath);
    } catch {
      return;
    }

    if (stats.size < MAX_LOG_BYTES) return;

    for (let index = MAX_ROTATIONS; index >= 1; index -= 1) {
      const source = index === 1 ? this.filePath : `${this.filePath}.${index - 1}`;
      const target = `${this.filePath}.${index}`;
      try {
        if (fs.existsSync(source)) fs.renameSync(source, target);
      } catch {
        return;
      }
    }
  }
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) {
    return JSON.stringify({ name: value.name, message: value.message });
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}
