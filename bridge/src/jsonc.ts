/**
 * JSONC (JSON with Comments) parser for broagentai.jsonc config files.
 *
 * Supports:
 * - Single-line comments (//)
 * - Multi-line comments (/* ... *\/)
 * - Trailing commas
 */

import { readFileSync } from "node:fs";

/**
 * Strip comments and trailing commas from JSONC text.
 */
export function stripJsonc(text: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  let stringChar = "";

  while (i < text.length) {
    const char = text[i];
    const nextChar = text[i + 1];

    // Handle string literals (don't strip comments inside strings)
    if (inString) {
      result += char;
      if (char === "\\" && i + 1 < text.length) {
        result += text[i + 1];
        i += 2;
        continue;
      }
      if (char === stringChar) {
        inString = false;
      }
      i++;
      continue;
    }

    // Start of string
    if (char === '"' || char === "'") {
      inString = true;
      stringChar = char;
      result += char;
      i++;
      continue;
    }

    // Single-line comment
    if (char === "/" && nextChar === "/") {
      // Skip until end of line
      while (i < text.length && text[i] !== "\n") {
        i++;
      }
      continue;
    }

    // Multi-line comment
    if (char === "/" && nextChar === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        i++;
      }
      i += 2; // Skip */
      continue;
    }

    result += char;
    i++;
  }

  // Remove trailing commas before } or ]
  return result.replace(/,\s*([}\]])/g, "$1");
}

/**
 * Parse a JSONC string into a JavaScript object.
 */
export function parseJsonc(text: string): unknown {
  const cleaned = stripJsonc(text);
  return JSON.parse(cleaned);
}

/**
 * Read and parse a JSONC file.
 */
export function readJsoncFile(path: string): unknown {
  const text = readFileSync(path, "utf8");
  return parseJsonc(text);
}
