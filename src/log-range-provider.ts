import { PollingJsonRpcProvider } from "@railgun-community/engine";
import type { JsonRpcError, JsonRpcPayload, JsonRpcResult } from "ethers";

export type LogRangeOptions = {
  /** Largest eth_getLogs block span sent to the RPC. Larger queries are split; omit to start unbounded. */
  maxBlockRange?: number;
  /** Retries per request after a rate-limit or transient error. */
  maxRetries?: number;
  /** First backoff delay; each retry doubles it up to maxDelayMs. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Parallel eth_getLogs requests while one large query is being split. */
  concurrency?: number;
  /** Called when the RPC rejects a range and the provider lowers its block span. */
  onRangeReduced?: (maxBlockRange: number) => void;
  /** Most eth_getLogs spans kept in memory for repeated queries; the oldest are dropped first. */
  maxCachedSpans?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

/** The last eth_getLogs span that still failed after splitting and retries. */
export type LogSpanFailure = {
  fromBlock: number;
  toBlock: number;
  /** The RPC's JSON-RPC error, or undefined when the request itself failed. */
  rpcError?: { code: number; message: string };
};

type RpcResponse = JsonRpcResult | JsonRpcError;
type LogFilter = Record<string, unknown> & { fromBlock?: unknown; toBlock?: unknown; blockHash?: unknown };

// Messages that free and archive RPCs use when a log query spans too many blocks or results.
const RANGE_LIMIT_PATTERN =
  /block range|range (is )?too (large|wide|big)|ranges? over|too many blocks|exceeds? (the )?(max(imum)? )?(block )?range|max(imum)? block range|query returned more than|response size|limited to \d+ blocks?/i;
// Messages and codes that mean "try the same request again later".
const RETRYABLE_PATTERN =
  /rate.?limit|too many requests|throttl|over capacity|exceeded .*(quota|capacity|compute units)|temporarily unavailable|timeout|timed out|\b(429|502|503|504|-32005|-32029|-32090)\b/i;
const HEX_QUANTITY = /^0x[0-9a-f]+$/i;

function describeError(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const fields = error as { code?: unknown; message?: unknown; shortMessage?: unknown; info?: { responseStatus?: unknown }; error?: { code?: unknown; message?: unknown } };
  return [fields.code, fields.message, fields.shortMessage, fields.info?.responseStatus, fields.error?.code, fields.error?.message]
    .filter((part) => part !== undefined && part !== null)
    .join(" ");
}

/** Reports whether an RPC error means the eth_getLogs block span or result size was too large. */
export function isRangeLimitError(error: unknown): boolean {
  return RANGE_LIMIT_PATTERN.test(describeError(error));
}

/** Reports whether an RPC error is a rate limit or transient failure worth retrying. */
export function isRetryableRpcError(error: unknown): boolean {
  return !isRangeLimitError(error) && RETRYABLE_PATTERN.test(describeError(error));
}

/** Splits an inclusive block range into consecutive spans of at most maxBlockRange blocks. */
export function splitBlockRange(fromBlock: number, toBlock: number, maxBlockRange: number): [number, number][] {
  const spans: [number, number][] = [];
  for (let start = fromBlock; start <= toBlock; start += maxBlockRange) {
    spans.push([start, Math.min(toBlock, start + maxBlockRange - 1)]);
  }
  return spans;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/** Identifies a log filter apart from its block range, so equal filters share cached spans. */
function spanFilterKey(filter: LogFilter): string {
  const fields = Object.keys(filter)
    .filter((name) => name !== "fromBlock" && name !== "toBlock")
    .sort()
    .map((name) => [name, filter[name]]);
  return JSON.stringify(fields, (_name, value: unknown) => (typeof value === "string" ? value.toLowerCase() : value));
}

class RpcResponseError extends Error {
  constructor(readonly rpcError: JsonRpcError["error"]) {
    super(rpcError.message);
  }
}

/**
 * Railgun scan provider for RPCs that cap eth_getLogs ranges or rate-limit requests.
 * It splits every numeric eth_getLogs query into spans of at most maxBlockRange blocks, halves the
 * span when the RPC still reports a range limit, and retries rate limits with exponential backoff.
 * Other methods are forwarded unchanged apart from the same retry policy.
 *
 * Spans are cached in memory, including ones still in flight. The engine abandons a 5,000-block
 * query after 10 seconds and repeats it; on a slow or throttled RPC the split query needs longer,
 * so without the cache every repeat starts over and the scan never gets past that query.
 */
export class LogRangeProvider extends PollingJsonRpcProvider {
  #maxBlockRange: number;
  readonly #maxRetries: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #concurrency: number;
  readonly #onRangeReduced: (maxBlockRange: number) => void;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #maxCachedSpans: number;
  readonly #spanCache = new Map<string, Promise<unknown[]>>();
  #lastLogFailure: LogSpanFailure | undefined;

  constructor(url: string, chainId: number, pollingInterval: number, options: LogRangeOptions = {}) {
    super(url, chainId, pollingInterval);
    this.#maxBlockRange = options.maxBlockRange ?? Number.POSITIVE_INFINITY;
    this.#maxRetries = options.maxRetries ?? 6;
    this.#baseDelayMs = options.baseDelayMs ?? 500;
    this.#maxDelayMs = options.maxDelayMs ?? 30_000;
    this.#concurrency = options.concurrency ?? 4;
    this.#onRangeReduced = options.onRangeReduced ?? (() => undefined);
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#maxCachedSpans = options.maxCachedSpans ?? 50_000;
  }

  /** The current eth_getLogs span limit, after any reductions learned from the RPC. */
  get maxBlockRange(): number {
    return this.#maxBlockRange;
  }

  /** The last eth_getLogs span the RPC refused, so a failed scan can explain why. */
  get lastLogFailure(): LogSpanFailure | undefined {
    return this.#lastLogFailure;
  }

  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    const payloads = Array.isArray(payload) ? payload : [payload];
    const responses = await Promise.all(payloads.map((single) => this.#sendOne(single)));
    // ethers reads JSON-RPC errors from the same array even though its type only names results.
    return responses as JsonRpcResult[];
  }

  async #sendOne(payload: JsonRpcPayload): Promise<RpcResponse> {
    const filter = payload.method === "eth_getLogs" ? (payload.params as LogFilter[] | undefined)?.[0] : undefined;
    if (
      filter &&
      filter.blockHash === undefined &&
      typeof filter.fromBlock === "string" &&
      typeof filter.toBlock === "string" &&
      HEX_QUANTITY.test(filter.fromBlock) &&
      HEX_QUANTITY.test(filter.toBlock)
    ) {
      const fromBlock = Number.parseInt(filter.fromBlock.slice(2), 16);
      const toBlock = Number.parseInt(filter.toBlock.slice(2), 16);
      if (fromBlock <= toBlock) {
        try {
          return { id: payload.id, result: await this.#getLogs(payload, filter, fromBlock, toBlock) };
        } catch (error) {
          if (error instanceof RpcResponseError) return { id: payload.id, error: error.rpcError };
          throw error;
        }
      }
    }
    return this.#sendWithRetry(payload);
  }

  async #getLogs(payload: JsonRpcPayload, filter: LogFilter, fromBlock: number, toBlock: number): Promise<unknown[]> {
    const spans = splitBlockRange(fromBlock, toBlock, this.#maxBlockRange);
    const results = await mapWithConcurrency(spans, this.#concurrency, ([start, end]) =>
      this.#getLogsSpan(payload, filter, start, end),
    );
    return results.flat();
  }

  async #getLogsSpan(payload: JsonRpcPayload, filter: LogFilter, fromBlock: number, toBlock: number): Promise<unknown[]> {
    // Another span may have lowered the limit while this one waited for a worker.
    if (toBlock - fromBlock + 1 > this.#maxBlockRange) return this.#getLogs(payload, filter, fromBlock, toBlock);

    const key = `${spanFilterKey(filter)}|${fromBlock}-${toBlock}`;
    const cached = this.#spanCache.get(key);
    if (cached) return cached;

    const pending = this.#fetchSpan(payload, filter, fromBlock, toBlock);
    this.#spanCache.set(key, pending);
    if (this.#spanCache.size > this.#maxCachedSpans) {
      this.#spanCache.delete(this.#spanCache.keys().next().value!);
    }
    // A failed span is forgotten so that the next attempt asks the RPC again.
    pending.catch(() => {
      if (this.#spanCache.get(key) === pending) this.#spanCache.delete(key);
    });
    return pending;
  }

  async #fetchSpan(payload: JsonRpcPayload, filter: LogFilter, fromBlock: number, toBlock: number): Promise<unknown[]> {
    let response: RpcResponse;
    try {
      response = await this.#sendWithRetry({
        ...payload,
        params: [{ ...filter, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}` }],
      });
    } catch (error) {
      this.#lastLogFailure = { fromBlock, toBlock };
      throw error;
    }
    if ("result" in response) return response.result as unknown[];

    const span = toBlock - fromBlock + 1;
    if (span > 1 && isRangeLimitError(response.error)) {
      const reduced = Math.max(1, Math.floor(span / 2));
      if (reduced < this.#maxBlockRange) {
        this.#maxBlockRange = reduced;
        this.#onRangeReduced(reduced);
      }
      return this.#getLogs(payload, filter, fromBlock, toBlock);
    }
    this.#lastLogFailure = {
      fromBlock,
      toBlock,
      rpcError: { code: Number(response.error.code), message: String(response.error.message) },
    };
    throw new RpcResponseError(response.error);
  }

  async #sendWithRetry(payload: JsonRpcPayload): Promise<RpcResponse> {
    for (let attempt = 0; ; attempt += 1) {
      let response: RpcResponse | undefined;
      let failure: unknown;
      try {
        [response] = (await super._send(payload)) as RpcResponse[];
      } catch (error) {
        failure = error;
      }
      if (response && "result" in response) return response;
      if (!response && failure === undefined) throw new Error("RPC returned an empty response");

      const error = response ? response.error : failure;
      if (attempt >= this.#maxRetries || !isRetryableRpcError(error)) {
        if (response) return response;
        throw failure;
      }
      const delay = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** attempt);
      await this.#sleep(delay / 2 + Math.random() * (delay / 2));
    }
  }
}
