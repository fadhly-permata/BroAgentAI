import { Readable } from "node:stream";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_MAX_INBOUND_FRAME_BYTES,
  FrameError,
  LENGTH_PREFIX_BYTES,
  encodeFrame,
  readFrames,
} from "./frames.ts";

async function collect(stream: Readable, max?: number): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const frame of readFrames(stream, max !== undefined ? { maxFrameBytes: max } : {})) {
    out.push(frame);
  }
  return out;
}

test("encodeFrame prefixes a uint32 LE body length", () => {
  const frame = encodeFrame({ hello: "world" });
  const declared = frame.readUInt32LE(0);
  assert.equal(declared, frame.length - LENGTH_PREFIX_BYTES);
  assert.deepEqual(JSON.parse(frame.subarray(LENGTH_PREFIX_BYTES).toString("utf8")), { hello: "world" });
});

test("roundtrip: encodeFrame -> readFrames", async () => {
  const frame = encodeFrame({ id: 1, method: "system.ping" });
  const frames = await collect(Readable.from([frame]));
  assert.deepEqual(frames, [{ id: 1, method: "system.ping" }]);
});

test("readFrames handles several frames packed into one chunk", async () => {
  const a = encodeFrame({ n: 1 });
  const b = encodeFrame({ n: 2 });
  const c = encodeFrame({ n: 3 });
  const frames = await collect(Readable.from([Buffer.concat([a, b, c])]));
  assert.deepEqual(frames, [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test("readFrames reassembles a frame split across chunks", async () => {
  const frame = encodeFrame({ payload: "a".repeat(1000) });
  const chunks = [frame.subarray(0, 2), frame.subarray(2, 7), frame.subarray(7)];
  const frames = await collect(Readable.from(chunks));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], { payload: "a".repeat(1000) });
});

test("readFrames rejects frames whose declared length exceeds the limit before allocating", async () => {
  const header = Buffer.alloc(LENGTH_PREFIX_BYTES);
  header.writeUInt32LE(5_000_000, 0);
  await assert.rejects(
    collect(Readable.from([header])),
    (err: unknown) => err instanceof FrameError && err.code === "FRAME_TOO_LARGE",
  );
});

test("readFrames rejects a stream that ends mid-frame", async () => {
  const frame = encodeFrame({ truncated: true });
  const partial = frame.subarray(0, frame.length - 2);
  await assert.rejects(
    collect(Readable.from([partial])),
    (err: unknown) => err instanceof FrameError && err.code === "FRAME_TRUNCATED",
  );
});

test("readFrames rejects a body that is not valid JSON", async () => {
  const body = Buffer.from("not json", "utf8");
  const header = Buffer.alloc(LENGTH_PREFIX_BYTES);
  header.writeUInt32LE(body.length, 0);
  await assert.rejects(
    collect(Readable.from([Buffer.concat([header, body])])),
    (err: unknown) => err instanceof FrameError && err.code === "FRAME_INVALID_JSON",
  );
});

test("encodeFrame rejects payloads larger than the outbound limit", () => {
  assert.throws(
    () => encodeFrame({ blob: "x".repeat(DEFAULT_MAX_INBOUND_FRAME_BYTES) }, { maxFrameBytes: 1024 }),
    (err: unknown) => err instanceof FrameError && err.code === "FRAME_TOO_LARGE",
  );
});
