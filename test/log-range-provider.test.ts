import { afterEach, describe, expect, it } from "bun:test";
import {
  LogRangeProvider,
  isRangeLimitError,
  isRetryableRpcError,
  splitBlockRange,
  type LogRangeOptions,
} from "../src/log-range-provider.ts";
import { startFakeRpc, type FakeRpcOptions } from "./fake-rpc.ts";

const CHAIN_ID = 8453;
const running: { stop: () => void; destroy: () => void }[] = [];

function setup(rpcOptions: Omit<FakeRpcOptions, "chainId">, providerOptions: LogRangeOptions = {}) {
  const rpc = startFakeRpc({ chainId: CHAIN_ID, ...rpcOptions });
  const delays: number[] = [];
  const provider = new LogRangeProvider(rpc.url, CHAIN_ID, 10_000, {
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
    ...providerOptions,
  });
  running.push({ stop: rpc.stop, destroy: () => provider.destroy() });
  return { rpc, provider, delays };
}

const getLogs = (provider: LogRangeProvider, fromBlock: number, toBlock: number) =>
  provider.send("eth_getLogs", [
    { address: "0x0000000000000000000000000000000000001234", fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}` },
  ]) as Promise<{ blockNumber: string }[]>;
const blocksOf = (logs: { blockNumber: string }[]) => logs.map((log) => Number.parseInt(log.blockNumber.slice(2), 16));

afterEach(() => {
  for (const { stop, destroy } of running.splice(0)) {
    destroy();
    stop();
  }
});

describe("eth_getLogs range splitting", () => {
  it("splits inclusive ranges into bounded spans", () => {
    expect(splitBlockRange(10, 259, 100)).toEqual([[10, 109], [110, 209], [210, 259]]);
    expect(splitBlockRange(5, 5, 100)).toEqual([[5, 5]]);
  });

  it("never sends a span above --chunk and returns every log in block order", async () => {
    const logBlocks = [1_000, 1_099, 1_100, 1_250, 2_999, 3_000];
    const { rpc, provider } = setup({ latestBlock: 5_000, maxLogRange: 100, logBlocks }, { maxBlockRange: 100 });

    const logs = await getLogs(provider, 1_000, 3_000);

    expect(blocksOf(logs)).toEqual(logBlocks);
    const ranges = rpc.logRanges();
    expect(ranges).toHaveLength(21);
    expect(ranges.every(([from, to]) => to - from + 1 <= 100)).toBe(true);
  });

  it("learns a free RPC's range limit when no --chunk is given", async () => {
    const reductions: number[] = [];
    const logBlocks = [20_000, 21_234, 24_999];
    const { provider } = setup(
      { latestBlock: 30_000, maxLogRange: 100, logBlocks },
      { onRangeReduced: (blocks) => reductions.push(blocks) },
    );

    const logs = await getLogs(provider, 20_000, 24_999);

    expect(blocksOf(logs)).toEqual(logBlocks);
    expect(provider.maxBlockRange).toBeLessThanOrEqual(100);
    expect(reductions.at(-1)).toBe(provider.maxBlockRange);
  });

  it("passes block-hash filters through unchanged", async () => {
    const { rpc, provider } = setup({ latestBlock: 100 }, { maxBlockRange: 10 });

    await provider.send("eth_getLogs", [{ blockHash: `0x${"ab".repeat(32)}` }]);

    expect(rpc.requests.filter((request) => request.method === "eth_getLogs")).toHaveLength(1);
  });
});

describe("span cache", () => {
  it("answers a repeated query from memory", async () => {
    const { rpc, provider } = setup({ latestBlock: 5_000, logBlocks: [1_050, 1_250] }, { maxBlockRange: 100 });

    const first = await getLogs(provider, 1_000, 1_299);
    const second = await getLogs(provider, 1_000, 1_299);

    expect(blocksOf(second)).toEqual(blocksOf(first));
    expect(rpc.logRanges()).toHaveLength(3);
  });

  it("joins spans that are still in flight instead of requesting them again", async () => {
    const { rpc, provider } = setup({ latestBlock: 5_000, logDelayMs: 200, logBlocks: [1_150] }, { maxBlockRange: 100 });

    // The engine abandons a slow query and repeats it while the first one is still running.
    const [first, repeat] = await Promise.all([getLogs(provider, 1_000, 1_299), getLogs(provider, 1_000, 1_299)]);

    expect(blocksOf(first)).toEqual([1_150]);
    expect(blocksOf(repeat)).toEqual([1_150]);
    expect(rpc.logRanges()).toHaveLength(3);
  });

  it("asks again for a span that failed, and keeps different filters apart", async () => {
    const { rpc, provider } = setup({ latestBlock: 5_000, rateLimitFirst: 1 }, { maxBlockRange: 100, maxRetries: 0 });

    await expect(getLogs(provider, 0, 99)).rejects.toThrow("rate limit");
    await getLogs(provider, 0, 99);
    await provider.send("eth_getLogs", [
      { address: "0x0000000000000000000000000000000000005678", fromBlock: "0x0", toBlock: "0x63" },
    ]);

    expect(rpc.logRanges()).toEqual([[0, 99], [0, 99], [0, 99]]);
  });
});

describe("rate limits and failures", () => {
  it("retries rate-limited requests with exponential backoff", async () => {
    const { provider, delays } = setup({ latestBlock: 500, rateLimitFirst: 3, logBlocks: [42] }, { baseDelayMs: 100 });

    const logs = await getLogs(provider, 0, 99);

    expect(blocksOf(logs)).toEqual([42]);
    expect(delays).toHaveLength(3);
    // Each delay is jittered within [half, full] of 100, 200, then 400 ms.
    delays.forEach((delay, attempt) => {
      expect(delay).toBeGreaterThanOrEqual(50 * 2 ** attempt);
      expect(delay).toBeLessThanOrEqual(100 * 2 ** attempt);
    });
  });

  it("gives up after the retry budget instead of returning empty logs", async () => {
    const { provider, delays } = setup({ latestBlock: 500, rateLimitFirst: 100 }, { maxRetries: 2 });

    await expect(getLogs(provider, 0, 99)).rejects.toThrow("rate limit");
    expect(delays).toHaveLength(2);
  });

  it("does not retry or split a non-retryable log failure", async () => {
    const { rpc, provider, delays } = setup({ latestBlock: 500, failLogs: true }, { maxBlockRange: 100 });

    await expect(getLogs(provider, 0, 99)).rejects.toThrow("log index unavailable");
    expect(rpc.logRanges()).toEqual([[0, 99]]);
    expect(delays).toHaveLength(0);
  });

  it("remembers the last span the RPC refused", async () => {
    const { provider } = setup({ latestBlock: 5_000, logsFromBlock: 4_000 }, { maxBlockRange: 100 });

    expect(provider.lastLogFailure).toBeUndefined();
    await getLogs(provider, 4_000, 4_099);
    await expect(getLogs(provider, 1_000, 1_099)).rejects.toThrow("historical logs");

    expect(provider.lastLogFailure).toEqual({
      fromBlock: 1_000,
      toBlock: 1_099,
      rpcError: { code: -32000, message: "historical logs are not available on this plan" },
    });
  });

  it("classifies common provider messages", () => {
    expect(isRangeLimitError({ code: 35, message: "ranges over 10000 blocks are not supported on free plan" })).toBe(true);
    expect(isRangeLimitError({ code: -32005, message: "query returned more than 10000 results" })).toBe(true);
    expect(isRangeLimitError({ code: -32600, message: "eth_getLogs is limited to a 500 block range" })).toBe(true);
    expect(isRetryableRpcError({ code: 429, message: "Too Many Requests" })).toBe(true);
    expect(isRetryableRpcError({ code: -32005, message: "rate limit exceeded" })).toBe(true);
    expect(isRetryableRpcError({ code: -32005, message: "query returned more than 10000 results" })).toBe(false);
    expect(isRetryableRpcError({ code: -32601, message: "method not found" })).toBe(false);
  });
});
