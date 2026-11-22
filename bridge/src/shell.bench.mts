import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { RpcServer } from "./rpc-server.ts";
import { WorkspaceStore } from "./workspace.ts";

const ws = mkdtempSync(join(tmpdir(), "ba-shell-bench-"));
const benchFile = join(ws, "bench.txt");
writeFileSync(benchFile, "x".repeat(200_000));

const server = new RpcServer({
  store: new WorkspaceStore({ configDir: mkdtempSync(join(tmpdir(), "ba-shell-bench-cfg-")) }),
});
await server.handle({ id: 0, method: "workspace.add", params: { path: ws } });

const command = process.platform === "win32" ? "Get-Content -Raw bench.txt" : "cat bench.txt";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

async function measure(run: () => Promise<void> | void, rounds = 7): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < rounds; i += 1) {
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

const shellMedianMs = await measure(async () => {
  const result = await server.invoke("shell.run", { command });
  if ((result as any).exitCode !== 0) throw new Error("benchmark command failed");
});

const nativeMedianMs = await measure(() => {
  readFileSync(benchFile, "utf8");
});

const ratio = shellMedianMs / Math.max(nativeMedianMs, 0.001);
const result = {
  platform: process.platform,
  shellMedianMs: Number(shellMedianMs.toFixed(2)),
  nativeMedianMs: Number(nativeMedianMs.toFixed(2)),
  ratio: Number(ratio.toFixed(2)),
  gate: ratio <= 1 ? "pass" : "block-native-tool-removal",
};

console.log(JSON.stringify(result, null, 2));
await server.shutdown();
