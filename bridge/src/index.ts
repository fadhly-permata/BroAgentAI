// @broagentai/bridge - Native messaging host entry point
//
// stdout is reserved for Native Messaging frames: never write to it.
// All diagnostics go through the logger, which targets stderr.
import { createLogger } from "./logger.ts";
import { readFrames, writeFrame } from "./frames.ts";
import { RpcServer } from "./rpc-server.ts";

const log = createLogger({ scope: "bridge" });

log.info("bridge starting");

/**
 * Chrome passes the calling extension origin as the first process argument.
 * The host manifest's `allowed_origins` already restricts who can launch us,
 * but we verify the origin shape as well and log the (redacted) origin.
 */
function readCallerOrigin(argv: string[]): string | null {
  const origin = argv.find((arg) => arg.startsWith("chrome-extension://") || arg.startsWith("moz-extension://"));
  return origin ?? null;
}

async function main(): Promise<void> {
  const origin = readCallerOrigin(process.argv.slice(2));
  const firefox = origin?.startsWith("moz-extension://") ?? false;
  const addonId = firefox ? origin!.slice("moz-extension://".length).replace(/\/$/, "") : null;
  log.info("bridge ready", { fields: { origin, browser: origin ? (firefox ? "firefox" : "chromium") : null, addonId } });

  const send = (payload: unknown): void => {
    writeFrame(process.stdout, payload).catch((error) => {
      log.error("failed to write frame", { fields: { error } });
    });
  };

  const server = new RpcServer({
    emit: (event, data) => send({ event, data }),
  });

  try {
    for await (const message of readFrames(process.stdin)) {
      // Requests run concurrently: a slow call (pull, MCP tool, folder dialog)
      // must not block terminal input or other panels. Responses carry the
      // request id, so arrival order does not matter.
      void server.handle(message).then(send);
    }
    log.info("stdin closed, shutting down");
  } catch (error) {
    log.error("bridge loop failed", { fields: { error } });
    process.exitCode = 1;
  } finally {
    await server.shutdown();
    // Child processes (PTYs, MCP servers) can keep the event loop alive.
    setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
  }
}

void main();
