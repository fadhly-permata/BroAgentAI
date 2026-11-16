import { test } from "node:test";
import assert from "node:assert/strict";
import { stripJsonc, parseJsonc } from "./jsonc.ts";

test("stripJsonc removes single-line comments", () => {
  const input = `{
    // This is a comment
    "key": "value"
  }`;
  const result = stripJsonc(input);
  assert.ok(!result.includes("//"));
  assert.ok(result.includes('"key": "value"'));
});

test("stripJsonc removes multi-line comments", () => {
  const input = `{
    /* This is a
       multi-line comment */
    "key": "value"
  }`;
  const result = stripJsonc(input);
  assert.ok(!result.includes("/*"));
  assert.ok(!result.includes("*/"));
  assert.ok(result.includes('"key": "value"'));
});

test("stripJsonc preserves strings with comment-like content", () => {
  const input = `{
    "url": "https://example.com // not a comment",
    "code": "/* also not a comment */"
  }`;
  const result = stripJsonc(input);
  assert.ok(result.includes("https://example.com // not a comment"));
  assert.ok(result.includes("/* also not a comment */"));
});

test("stripJsonc removes trailing commas", () => {
  const input = `{
    "a": 1,
    "b": 2,
  }`;
  const result = stripJsonc(input);
  assert.ok(!result.includes(",\n  }"));
});

test("parseJsonc parses valid JSONC", () => {
  const input = `{
    // Approval mode
    "approval": "ask",
    /* Tool overrides */
    "toolOverrides": [
      { "tool": "fs.read", "approval": "auto" },
    ],
  }`;
  const result = parseJsonc(input) as any;
  assert.equal(result.approval, "ask");
  assert.equal(result.toolOverrides.length, 1);
  assert.equal(result.toolOverrides[0].tool, "fs.read");
});

test("parseJsonc throws on invalid JSON", () => {
  const input = `{ invalid }`;
  assert.throws(() => parseJsonc(input));
});
