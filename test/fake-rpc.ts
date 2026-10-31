// A local JSON-RPC server for scan tests. It never forwards anything to a real network.

export type FakeRpcOptions = {
  chainId: number;
  latestBlock: number;
  /** Reject eth_getLogs spans wider than this, the way free RPC plans do. */
  maxLogRange?: number;
  /** Answer the first N eth_getLogs requests with a JSON-RPC rate-limit error. */
  rateLimitFirst?: number;
  /** Fail every eth_getLogs request with a non-retryable error. */
  failLogs?: boolean;
  /** Refuse eth_getLogs below this block, like plans that keep only recent logs. */
  logsFromBlock?: number;
  /** Delay before answering each eth_getLogs request, like a slow or throttled RPC. */
  logDelayMs?: number;
  /** Blocks that contain one synthetic log each. */
  logBlocks?: number[];
  /** Answers eth_simulateV1; without it the method is unsupported, as on many RPCs. */
  simulateV1?: (params: unknown[]) => unknown;
};

export type FakeRpcRequest = { method: string; params: unknown[] };

type Payload = { id: number | string; method: string; params?: unknown[] };

const hex = (value: number) => `0x${value.toString(16)}`;
const word = (value: number) => `0x${value.toString(16).padStart(64, "0")}`;

export function startFakeRpc(options: FakeRpcOptions) {
  const requests: FakeRpcRequest[] = [];
  let rateLimitsLeft = options.rateLimitFirst ?? 0;

  const answer = (payload: Payload) => {
    const params = payload.params ?? [];
    requests.push({ method: payload.method, params });
    const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: payload.id, error: { code, message } });
    const result = (value: unknown) => ({ jsonrpc: "2.0", id: payload.id, result: value });

    if (payload.method === "eth_getLogs" && rateLimitsLeft > 0) {
      rateLimitsLeft -= 1;
      return error(-32005, "rate limit exceeded, too many requests");
    }
    switch (payload.method) {
      case "eth_chainId":
        return result(hex(options.chainId));
      case "net_version":
        return result(String(options.chainId));
      case "eth_blockNumber":
        return result(hex(options.latestBlock));
      case "eth_simulateV1":
        if (!options.simulateV1) return error(-32601, "the method eth_simulateV1 does not exist");
        return result(options.simulateV1(params));
      case "eth_call":
        // The engine's only call here is rootHistory(tree, root); answer true so roots validate.
        return result(word(1));
      case "eth_getLogs": {
        if (options.failLogs) return error(-32000, "internal error: log index unavailable");
        const filter = params[0] as { fromBlock?: string; toBlock?: string; blockHash?: string };
        if (filter.blockHash) return result([]);
        const from = Number.parseInt(filter.fromBlock!.slice(2), 16);
        const to = Number.parseInt(filter.toBlock!.slice(2), 16);
        if (options.maxLogRange !== undefined && to - from + 1 > options.maxLogRange) {
          return error(35, `ranges over ${options.maxLogRange} blocks are not supported on free plan`);
        }
        if (options.logsFromBlock !== undefined && from < options.logsFromBlock) {
          return error(-32000, "historical logs are not available on this plan");
        }
        const logs = (options.logBlocks ?? [])
          .filter((block) => block >= from && block <= to)
          .map((block) => ({
            address: "0x0000000000000000000000000000000000001234",
            topics: [word(1)],
            data: "0x",
            blockNumber: hex(block),
            blockHash: word(block),
            transactionHash: word(block + 1),
            transactionIndex: "0x0",
            logIndex: "0x0",
            removed: false,
          }));
        return result(logs);
      }
      case "eth_getBlockByNumber": {
        const tag = params[0] as string;
        const number = tag.startsWith("0x") ? Number.parseInt(tag.slice(2), 16) : options.latestBlock;
        return result({
          number: hex(number),
          hash: word(number),
          parentHash: word(number - 1),
          timestamp: hex(1_700_000_000 + number),
          gasLimit: hex(30_000_000),
          gasUsed: "0x0",
          baseFeePerGas: "0x1",
          miner: "0x0000000000000000000000000000000000000000",
          extraData: "0x",
          difficulty: "0x0",
          nonce: "0x0000000000000000",
          transactions: [],
        });
      }
      default:
        return error(-32601, `method ${payload.method} is not supported by the fake RPC`);
    }
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = (await request.json()) as Payload | Payload[];
      if (options.logDelayMs && [body].flat().some((payload) => payload.method === "eth_getLogs")) {
        await Bun.sleep(options.logDelayMs);
      }
      return Response.json(Array.isArray(body) ? body.map(answer) : answer(body));
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    logRanges: () =>
      requests
        .filter((request) => request.method === "eth_getLogs" && (request.params[0] as { fromBlock?: string }).fromBlock)
        .map((request) => {
          const filter = request.params[0] as { fromBlock: string; toBlock: string };
          return [Number.parseInt(filter.fromBlock.slice(2), 16), Number.parseInt(filter.toBlock.slice(2), 16)] as const;
        }),
    stop: () => server.stop(true),
  };
}
