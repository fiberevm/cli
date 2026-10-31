import { afterEach, describe, expect, it } from "bun:test";
import { getFiberPrivateDeployment } from "../src/chains.ts";
import { listPrivateAssets } from "../src/private-assets.ts";
import { startFakeRpc } from "./fake-rpc.ts";

// Base deployment from the public chain registry; the fake RPC serves a short window after it.
const BASE = getFiberPrivateDeployment(8453)!;
const LATEST_BLOCK = BASE.deploymentBlock + 1_200;
// A synthetic seed: no real wallet can be derived from a constant pattern used only in tests.
const syntheticSeed = () => new Uint8Array(32).fill(0x5a);
const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

describe("private asset scans on range-limited RPCs", () => {
  it("completes with --chunk on an RPC that rejects wide eth_getLogs ranges", async () => {
    const rpc = startFakeRpc({ chainId: 8453, latestBlock: LATEST_BLOCK, maxLogRange: 100 });
    stops.push(rpc.stop);
    const progress: string[] = [];

    const scan = await listPrivateAssets({
      seed: syntheticSeed(),
      rpcUrl: rpc.url,
      chunkSize: 100,
      onProgress: (message) => progress.push(message),
    });

    expect(scan).toEqual({ chainId: 8453, network: "Base", assets: [] });
    const ranges = rpc.logRanges();
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.every(([from, to]) => to - from + 1 <= 100)).toBe(true);
    // The whole window from the deployment block to the latest block was requested.
    expect(Math.min(...ranges.map(([from]) => from))).toBeLessThanOrEqual(BASE.deploymentBlock);
    expect(Math.max(...ranges.map(([, to]) => to))).toBe(LATEST_BLOCK);
    expect(progress.some((message) => message.includes("limits eth_getLogs"))).toBe(false);
  }, 60_000);

  it("learns the RPC's range limit when --chunk is omitted", async () => {
    const rpc = startFakeRpc({ chainId: 8453, latestBlock: LATEST_BLOCK, maxLogRange: 100 });
    stops.push(rpc.stop);
    const progress: string[] = [];

    const scan = await listPrivateAssets({
      seed: syntheticSeed(),
      rpcUrl: rpc.url,
      onProgress: (message) => progress.push(message),
    });

    expect(scan.assets).toEqual([]);
    expect(progress.some((message) => message.includes("limits eth_getLogs ranges"))).toBe(true);
    expect(Math.max(...rpc.logRanges().map(([, to]) => to))).toBe(LATEST_BLOCK);
  }, 60_000);

  it("retries rate-limited requests instead of stopping the scan", async () => {
    const rpc = startFakeRpc({ chainId: 8453, latestBlock: LATEST_BLOCK, maxLogRange: 100, rateLimitFirst: 3 });
    stops.push(rpc.stop);

    const scan = await listPrivateAssets({ seed: syntheticSeed(), rpcUrl: rpc.url, chunkSize: 100 });

    expect(scan.assets).toEqual([]);
    expect(Math.max(...rpc.logRanges().map(([, to]) => to))).toBe(LATEST_BLOCK);
  }, 60_000);

  it("finishes when each 5,000-block engine query outlasts the engine's 10-second timeout", async () => {
    // 13 spans of 100 blocks, 4 at a time, 3 s each: about 12 s per engine query, so the engine
    // abandons and repeats it. Cached spans let the repeat finish instead of starting over.
    const rpc = startFakeRpc({ chainId: 8453, latestBlock: LATEST_BLOCK, maxLogRange: 100, logDelayMs: 3_000 });
    stops.push(rpc.stop);

    const scan = await listPrivateAssets({ seed: syntheticSeed(), rpcUrl: rpc.url, chunkSize: 100 });

    expect(scan.assets).toEqual([]);
    const ranges = rpc.logRanges().map(([from, to]) => `${from}-${to}`);
    expect(Math.max(...rpc.logRanges().map(([, to]) => to))).toBe(LATEST_BLOCK);
    // Every span was requested once, even though the engine repeated the query.
    expect(new Set(ranges).size).toBe(ranges.length);
  }, 90_000);

  it("still fails, with a --chunk hint, when log queries keep failing", async () => {
    const rpc = startFakeRpc({ chainId: 8453, latestBlock: LATEST_BLOCK, failLogs: true });
    stops.push(rpc.stop);

    // Bun's expect().rejects waits out the engine's leftover timers; capture the error instead.
    const error = await listPrivateAssets({ seed: syntheticSeed(), rpcUrl: rpc.url, chunkSize: 100 }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect((error as Error).message).toContain("stopped before reading the pool's full history");
    expect((error as Error).message).toContain("--chunk");
  }, 60_000);

  it("says the RPC keeps no history, without a --chunk hint, when only recent logs are served", async () => {
    const rpc = startFakeRpc({ chainId: 8453, latestBlock: LATEST_BLOCK, maxLogRange: 100, logsFromBlock: LATEST_BLOCK - 50 });
    stops.push(rpc.stop);

    const error = await listPrivateAssets({ seed: syntheticSeed(), rpcUrl: rpc.url, chunkSize: 100 }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    const message = (error as Error).message;
    expect(message).toContain("stopped before reading the pool's full history");
    expect(message).toContain("answers eth_getLogs for recent blocks");
    expect(message).toContain(`back to block ${BASE.deploymentBlock}`);
    expect(message).not.toContain("retry with a smaller --chunk");
  }, 60_000);
});
