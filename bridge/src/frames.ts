import {
  MAX_EXTENSION_TO_HOST_BYTES,
  MAX_HOST_TO_EXTENSION_BYTES,
} from "@browseragent/shared";

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    if (chunk.length === 0) return [];

    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);

      if (length === 0) {
        throw new FrameError("Received zero-length frame");
      }

      if (length > MAX_EXTENSION_TO_HOST_BYTES) {
        throw new FrameError(`Incoming frame exceeds ${MAX_EXTENSION_TO_HOST_BYTES} bytes`);
      }

      if (this.buffer.length < 4 + length) break;

      const payload = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);

      let text: string;
      try {
        text = payload.toString("utf8");
      } catch {
        throw new FrameError("Frame payload is not valid UTF-8");
      }

      try {
        messages.push(JSON.parse(text) as unknown);
      } catch {
        throw new FrameError("Frame payload is not valid JSON");
      }
    }

    return messages;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }

  get pendingBytes(): number {
    return this.buffer.length;
  }
}

export function encodeFrame(message: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8");

  if (json.length === 0) {
    throw new FrameError("Refusing to encode an empty frame");
  }

  if (json.length > MAX_HOST_TO_EXTENSION_BYTES) {
    throw new FrameError(`Outgoing frame exceeds ${MAX_HOST_TO_EXTENSION_BYTES} bytes`);
  }

  const frame = Buffer.allocUnsafe(4 + json.length);
  frame.writeUInt32LE(json.length, 0);
  json.copy(frame, 4);
  return frame;
}
