import { createInterface } from "node:readline/promises";
import { stderr, stdin } from "node:process";
import {
  AbiCoder,
  JsonRpcProvider,
  Transaction,
  getAddress,
  type JsonRpcPayload,
  type JsonRpcResult,
} from "ethers";

import { SIGNING_METHODS } from "./log-range-provider.ts";

/** The exact word the user must type before recover signs anything. */
export const CONFIRMATION_WORD = "CONFIRM";

/**
 * Provider for broadcasting: every signing method is refused except eth_sendRawTransaction, and a raw
 * transaction passes only if it matches one allowed with allow() (same target and calldata), is signed
 * by the expected account on the expected chain, and sends no native value. Each allowance is consumed
 * by use, so a transaction can never be broadcast twice or swapped for a different one.
 */
export class GuardedSendProvider extends JsonRpcProvider {
  readonly signer: string;
  readonly chainId: number;
  readonly #allowed = new Map<string, string>();

  constructor(url: string, chainId: number, signer: string) {
    super(url, chainId, { staticNetwork: true, batchMaxCount: 1 });
    this.chainId = chainId;
    this.signer = getAddress(signer);
  }

  allow(to: string, data: string, label: string): void {
    this.#allowed.set(`${to.toLowerCase()}|${data.toLowerCase()}`, label);
  }

  /** Returns the label of the matching allowed transaction and consumes it; throws BLOCKED otherwise. */
  validateRawTransaction(raw: string): string {
    let transaction: Transaction;
    try {
      transaction = Transaction.from(raw);
    } catch {
      throw new Error("BLOCKED: unreadable signed transaction");
    }
    if (transaction.chainId !== BigInt(this.chainId)) {
      throw new Error(`BLOCKED: chain ${transaction.chainId}, expected ${this.chainId}`);
    }
    if (transaction.from !== this.signer) throw new Error(`BLOCKED: signed by ${transaction.from}, expected ${this.signer}`);
    if (transaction.value !== 0n) throw new Error("BLOCKED: the transaction sends native value");
    const key = `${transaction.to?.toLowerCase()}|${transaction.data.toLowerCase()}`;
    const label = this.#allowed.get(key);
    if (!label) throw new Error(`BLOCKED: the transaction to ${transaction.to} is not part of the confirmed plan`);
    this.#allowed.delete(key);
    return label;
  }

  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    for (const single of Array.isArray(payload) ? payload : [payload]) {
      if (single.method === "eth_sendRawTransaction") this.validateRawTransaction((single.params as string[])[0]!);
      else if (SIGNING_METHODS.test(single.method)) throw new Error(`BLOCKED: ${single.method} is not allowed`);
    }
    return super._send(payload);
  }
}

async function readTerminalLine(question: string): Promise<string> {
  const terminal = createInterface({ input: stdin, output: stderr });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}

/** Resolves true only when the answer is exactly CONFIRM (surrounding spaces ignored). */
export async function askForConfirmation(read: (question: string) => Promise<string> = readTerminalLine): Promise<boolean> {
  const answer = await read(`\nType ${CONFIRMATION_WORD} and press Enter to sign and send these transactions (anything else cancels): `);
  return answer.trim() === CONFIRMATION_WORD;
}

const coder = AbiCoder.defaultAbiCoder();

/** Turns revert data into readable text: Error(string), Panic(uint256), or the raw custom-error selector. */
export function describeRevert(data?: string, fallback?: string): string {
  if (data?.startsWith("0x08c379a0")) {
    try {
      return `revert: ${coder.decode(["string"], `0x${data.slice(10)}`)[0]}`;
    } catch {
      // fall through to the raw selector
    }
  }
  if (data?.startsWith("0x4e487b71")) {
    try {
      return `panic 0x${(coder.decode(["uint256"], `0x${data.slice(10)}`)[0] as bigint).toString(16)}`;
    } catch {
      // fall through to the raw selector
    }
  }
  if (data && data.length >= 10) return `custom error ${data.slice(0, 10)} (data ${data.slice(0, 138)})`;
  return fallback ?? "revert without data";
}
