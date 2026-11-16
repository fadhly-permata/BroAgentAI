/**
 * Native Messaging framing for the BroAgentAI bridge.
 *
 * Both directions of the browser <-> native host channel share the same wire
 * format: a 4-byte unsigned little-endian length prefix followed by a UTF-8
 * encoded JSON body.
 *
 *   [ length: uint32 LE ][ body: JSON utf8 ]
 *
 * Chrome enforces a hard cap of 1 MB on extension -> host messages and a
 * 1 GB cap on host -> extension messages. We enforce both here so a buggy or
 * hostile peer can never trick us into an unbounded allocation: the declared
 * length is validated *before* any body buffer is created.
 */

import { Buffer } from "node:buffer";
import type { Readable, Writable } from "node:stream";

/** Size of the little-endian uint32 length prefix that precedes every frame. */
export const LENGTH_PREFIX_BYTES = 4;

/** Chrome's hard limit on messages sent *from* the extension *to* the host. */
export const DEFAULT_MAX_INBOUND_FRAME_BYTES = 1024 * 1024; // 1 MiB

/** Chrome's hard limit on messages sent *from* the host *to* the extension. */
export const DEFAULT_MAX_OUTBOUND_FRAME_BYTES = 1024 * 1024 * 1024; // 1 GiB

/** Reason a frame could not be encoded or decoded. */
export type FrameErrorCode =
  | "FRAME_TOO_LARGE"
  | "FRAME_INVALID_JSON"
  | "FRAME_TRUNCATED"
  | "FRAME_NOT_SERIALIZABLE";

/**
 * Error raised when a frame violates the Native Messaging wire contract.
 * `code` is stable and safe to surface across the RPC boundary.
 */
export class FrameError extends Error {
  readonly code: FrameErrorCode;

  constructor(code: FrameErrorCode, message: string) {
    super(message);
    this.name = "FrameError";
    this.code = code;
  }
}

export interface ReadFramesOptions {
  /** Maximum body bytes a single inbound frame may declare. Defaults to 1 MiB. */
  maxFrameBytes?: number;
}

export interface WriteFrameOptions {
  /** Maximum body bytes a single outbound frame may contain. Defaults to 1 GiB. */
  maxFrameBytes?: number;
}

/**
 * Serialize `payload` into a Native Messaging frame.
 *
 * Throws {@link FrameError} with code `FRAME_NOT_SERIALIZABLE` when the payload
 * cannot be represented as JSON (e.g. a function or a circular structure), and
 * `FRAME_TOO_LARGE` when the encoded body exceeds the outbound limit.
 */
export function encodeFrame(payload: unknown, options: WriteFrameOptions = {}): Buffer {
  const limit = options.maxFrameBytes ?? DEFAULT_MAX_OUTBOUND_FRAME_BYTES;

  let json: string | undefined;
  try {
    json = JSON.stringify(payload);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new FrameError("FRAME_NOT_SERIALIZABLE", `payload could not be serialized to JSON: ${reason}`);
  }

  if (typeof json !== "string") {
    throw new FrameError(
      "FRAME_NOT_SERIALIZABLE",
      "payload serialized to undefined (functions and symbols are not valid frames)",
    );
  }

  const body = Buffer.from(json, "utf8");
  if (body.length > limit) {
    throw new FrameError(
      "FRAME_TOO_LARGE",
      `outbound frame body is ${body.length} bytes, exceeds limit of ${limit}`,
    );
  }

  const frame = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, LENGTH_PREFIX_BYTES);
  return frame;
}

/**
 * Encode `payload` and write it to `stream` in a single call.
 *
 * Resolves once the underlying stream has flushed the frame, and rejects if
 * encoding fails or the stream reports an error.
 */
export function writeFrame(
  stream: Writable,
  payload: unknown,
  options: WriteFrameOptions = {},
): Promise<void> {
  let frame: Buffer;
  try {
    frame = encodeFrame(payload, options);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise<void>((resolve, reject) => {
    stream.write(frame, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Decode a stream of Native Messaging frames.
 *
 * Yields each parsed JSON payload in arrival order. Frames may be split across
 * chunks or several frames may be packed into one chunk; both cases are handled.
 *
 * The generator throws {@link FrameError} when a declared length exceeds
 * `maxFrameBytes` (checked before allocation), when a body fails to parse as
 * JSON, or when the stream ends mid-frame.
 */
export async function* readFrames(
  stream: Readable,
  options: ReadFramesOptions = {},
): AsyncGenerator<unknown, void, void> {
  const limit = options.maxFrameBytes ?? DEFAULT_MAX_INBOUND_FRAME_BYTES;
  let pending: Buffer = Buffer.alloc(0);

  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    // Concatenating per-chunk is O(n^2) in the worst case, but Native Messaging
    // frames are small JSON envelopes and almost always arrive in a single
    // 64 KiB read. Optimize only if profiling shows it matters.
    pending = pending.length === 0 ? buf : Buffer.concat([pending, buf]);

    while (pending.length >= LENGTH_PREFIX_BYTES) {
      const declared = pending.readUInt32LE(0);
      if (declared > limit) {
        throw new FrameError(
          "FRAME_TOO_LARGE",
          `inbound frame declares ${declared} bytes, exceeds limit of ${limit}`,
        );
      }

      const totalBytes = LENGTH_PREFIX_BYTES + declared;
      if (pending.length < totalBytes) break;

      const body = pending.subarray(LENGTH_PREFIX_BYTES, totalBytes);
      pending = pending.subarray(totalBytes);
      yield parseBody(body);
    }
  }

  if (pending.length !== 0) {
    throw new FrameError(
      "FRAME_TRUNCATED",
      `stream ended with ${pending.length} unconsumed byte(s) of a partial frame`,
    );
  }
}

function parseBody(body: Buffer): unknown {
  const text = body.toString("utf8");
  if (text.length === 0) {
    throw new FrameError("FRAME_INVALID_JSON", "frame body is empty (0 bytes)");
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new FrameError("FRAME_INVALID_JSON", `failed to parse frame body as JSON: ${reason}`);
  }
}
