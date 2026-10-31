import { afterEach, describe, expect, it } from "bun:test";
import { AbiCoder, Wallet } from "ethers";
import { LogRangeProvider } from "../src/log-range-provider.ts";
import {
  CONFIRMATION_WORD,
  GuardedSendProvider,
  askForConfirmation,
  describeRevert,
} from "../src/transaction-guards.ts";

const CHAIN_ID = 8453;
// Synthetic accounts and targets; port 9 (discard) is closed, so nothing can reach a network.
const signer = Wallet.createRandom();
const target = "0x000000000000000000000000000000000000dEaD";
const otherTarget = "0x000000000000000000000000000000000000bEEF";
const plannedData = "0x12345678";
const providers: { destroy: () => void }[] = [];

function guarded() {
  const provider = new GuardedSendProvider("http://127.0.0.1:9", CHAIN_ID, signer.address);
  provider.allow(target, plannedData, "planned");
  providers.push(provider);
  return provider;
}

const sign = (changes: Record<string, unknown> = {}, wallet: Pick<Wallet, "signTransaction"> = signer) =>
  wallet.signTransaction({
    type: 2, chainId: CHAIN_ID, nonce: 0, to: target, data: plannedData, value: 0n,
    gasLimit: 100_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000n, ...changes,
  });

async function expectBlocked(provider: GuardedSendProvider, raw: string, reason: string) {
  await expect(provider.send("eth_sendRawTransaction", [raw])).rejects.toThrow(`BLOCKED: ${reason}`);
}

afterEach(() => {
  for (const provider of providers.splice(0)) provider.destroy();
});

describe("guarded send provider", () => {
  it("lets each planned transaction through exactly once", async () => {
    const provider = guarded();
    const raw = await sign();

    expect(provider.validateRawTransaction(raw)).toBe("planned");
    expect(() => provider.validateRawTransaction(raw)).toThrow("not part of the confirmed plan");
  });

  it("blocks anything that differs from the confirmed plan before it reaches the RPC", async () => {
    const provider = guarded();
    await expectBlocked(provider, await sign({ data: "0x87654321" }), "the transaction to");
    await expectBlocked(provider, await sign({ to: otherTarget }), "the transaction to");
    await expectBlocked(provider, await sign({ value: 1n }), "the transaction sends native value");
    await expectBlocked(provider, await sign({ chainId: 1 }), "chain 1, expected 8453");
    await expectBlocked(provider, await sign({}, Wallet.createRandom()), "signed by");
    await expectBlocked(provider, "0x1234", "unreadable signed transaction");
  });

  it("refuses node-side signing methods", async () => {
    const provider = guarded();
    for (const [method, params] of [
      ["eth_sendTransaction", [{}]],
      ["eth_sign", [signer.address, "0x00"]],
      ["personal_sign", ["0x00", signer.address]],
      ["eth_signTypedData_v4", [signer.address, "{}"]],
    ] as const) {
      await expect(provider.send(method, [...params])).rejects.toThrow(`BLOCKED: ${method} is not allowed`);
    }
  });

  it("keeps the scan provider read-only", async () => {
    const provider = new LogRangeProvider("http://127.0.0.1:9", CHAIN_ID, 10_000);
    providers.push(provider);
    await expect(provider.send("eth_sendRawTransaction", [await sign()])).rejects.toThrow("BLOCKED: eth_sendRawTransaction");
  });
});

describe("confirmation", () => {
  it("accepts only the exact confirmation word", async () => {
    expect(CONFIRMATION_WORD).toBe("CONFIRM");
    const answers: [string, boolean][] = [
      ["CONFIRM", true],
      ["  CONFIRM  ", true],
      ["confirm", false],
      ["CONFIRM.", false],
      ["yes", false],
      ["", false],
    ];
    for (const [answer, expected] of answers) {
      expect(await askForConfirmation(async () => answer)).toBe(expected);
    }
  });
});

describe("revert descriptions", () => {
  const coder = AbiCoder.defaultAbiCoder();

  it("decodes Error(string), Panic(uint256), and custom errors", () => {
    expect(describeRevert(`0x08c379a0${coder.encode(["string"], ["paused"]).slice(2)}`)).toBe("revert: paused");
    expect(describeRevert(`0x4e487b71${coder.encode(["uint256"], [0x11]).slice(2)}`)).toBe("panic 0x11");
    expect(describeRevert("0x0229762f000000000000000000000000000000000000000000000000000000000000dead")).toStartWith(
      "custom error 0x0229762f",
    );
    expect(describeRevert("0x", "execution reverted")).toBe("execution reverted");
  });
});
