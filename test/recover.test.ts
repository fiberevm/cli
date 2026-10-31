import { afterEach, describe, expect, it } from "bun:test";
import { AbiCoder, JsonRpcProvider, zeroPadValue } from "ethers";
import { FIBER_PRIVATE_DEPLOYMENTS } from "../src/chains.ts";
import {
  assertRecoverChain,
  describePlan,
  runRecovery,
  signerCanPayGas,
  simulateCalls,
  sumTransfers,
  type RecoveryPlan,
} from "../src/recover.ts";
import { startFakeRpc } from "./fake-rpc.ts";

// Synthetic addresses only.
const POOL = "0x00000000000000000000000000000000000000A1";
const VAULT = "0x00000000000000000000000000000000000000B2";
const ASSET = "0x00000000000000000000000000000000000000C3";
const SIGNER = "0x00000000000000000000000000000000000000D4";
const RECEIVER = "0x00000000000000000000000000000000000000E5";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const coder = AbiCoder.defaultAbiCoder();
const transferLog = (token: string, from: string, to: string, value: bigint) => ({
  address: token,
  topics: [TRANSFER, zeroPadValue(from, 32), zeroPadValue(to, 32)],
  data: coder.encode(["uint256"], [value]),
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function providerFor(simulateV1?: (params: unknown[]) => unknown) {
  const rpc = startFakeRpc({ chainId: 8453, latestBlock: 1_000, simulateV1 });
  const provider = new JsonRpcProvider(rpc.url, 8453, { staticNetwork: true });
  cleanups.push(() => provider.destroy(), rpc.stop);
  return { rpc, provider };
}

describe("supported chains", () => {
  it("allows Base and rejects every other Fiber private pool", () => {
    expect(() => assertRecoverChain(8453)).not.toThrow();
    for (const { chainId } of FIBER_PRIVATE_DEPLOYMENTS.filter((deployment) => deployment.chainId !== 8453)) {
      expect(() => assertRecoverChain(chainId)).toThrow("recover is available only on Base");
    }
  });

  it("stops before scanning or signing when the RPC is on another chain", async () => {
    const rpc = startFakeRpc({ chainId: 56, latestBlock: 1_000 });
    cleanups.push(rpc.stop);
    let confirmed = false;

    await expect(
      runRecovery({
        seed: new Uint8Array(32).fill(0x5a),
        rpcUrl: rpc.url,
        token: VAULT,
        derivationIndex: 1,
        dryRun: true,
        confirm: async () => (confirmed = true),
        onProgress: () => undefined,
        output: () => undefined,
      }),
    ).rejects.toThrow("recover is available only on Base");
    expect(rpc.requests.map((request) => request.method)).toEqual(["eth_chainId"]);
    expect(confirmed).toBe(false);
  });
});

describe("eth_simulateV1 simulation", () => {
  it("runs calls in order and decodes successes, reverts, and logs", async () => {
    let request: unknown;
    const revert = `0x08c379a0${coder.encode(["string"], ["paused"]).slice(2)}`;
    const { provider } = providerFor((params) => {
      request = params;
      return [{
        calls: [
          { status: "0x1", returnData: "0x", gasUsed: "0x7a120", logs: [transferLog(VAULT, POOL, SIGNER, 5n)] },
          { status: "0x0", returnData: revert, gasUsed: "0x5208", error: { message: "execution reverted", data: revert } },
        ],
      }];
    });

    const [unshield, redeem] = await simulateCalls(provider, [
      { label: "unshield", from: SIGNER, to: POOL, data: "0x01" },
      { label: "redeem", from: SIGNER, to: VAULT, data: "0x02" },
    ]);

    expect(unshield).toMatchObject({ label: "unshield", ok: true, gasUsed: 500_000n });
    expect(sumTransfers(unshield!.logs, VAULT, SIGNER, POOL)).toBe(5n);
    expect(redeem).toMatchObject({ label: "redeem", ok: false, error: "revert: paused" });
    // Signature checks are off, so the sender needs no key or gas money in the simulation.
    expect((request as [{ validation: boolean; blockStateCalls: { calls: { from: string }[] }[] }])[0]).toMatchObject({
      validation: false,
      blockStateCalls: [{ calls: [{ from: SIGNER }, { from: SIGNER }] }],
    });
  });

  it("refuses to continue when the RPC cannot simulate", async () => {
    const { provider } = providerFor();
    await expect(simulateCalls(provider, [{ label: "unshield", from: SIGNER, to: POOL, data: "0x01" }])).rejects.toThrow(
      "could not run eth_simulateV1, which recover requires before signing",
    );
  });
});

describe("transfer accounting", () => {
  it("sums only matching token, recipient, and sender", () => {
    const logs = [
      transferLog(VAULT, POOL, SIGNER, 7n),
      transferLog(VAULT, POOL, SIGNER, 3n),
      transferLog(VAULT, POOL, RECEIVER, 100n),
      transferLog(ASSET, POOL, SIGNER, 100n),
      transferLog(VAULT, RECEIVER, SIGNER, 100n),
    ];
    expect(sumTransfers(logs, VAULT, SIGNER, POOL)).toBe(10n);
    expect(sumTransfers(logs, VAULT, SIGNER)).toBe(110n);
  });
});

describe("recovery plan", () => {
  const plan: RecoveryPlan = {
    chainId: 8453,
    networkName: "Base",
    pool: POOL,
    signer: SIGNER,
    token: VAULT,
    tokenSymbol: "vTOKEN",
    tokenDecimals: 18,
    amount: 2_000_000_000_000_000_000n,
    received: 2_000_000_000_000_000_000n,
    feeBasisPoints: 0n,
    redeem: { receiver: RECEIVER, asset: ASSET, assetSymbol: "TOKEN", assetDecimals: 6, expectedAssets: 2_000_000n },
    transactions: [
      { label: "unshield", to: POOL, data: "0x01", gasLimit: 600_000n, gasSource: "simulated 461538 x 1.3", l1Fee: 10n },
      { label: "redeem", to: VAULT, data: "0x02", gasLimit: 650_000n, gasSource: "simulated 500000 x 1.3", l1Fee: 10n },
    ],
    nonce: 4,
    maxFeePerGas: 10_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    maxCost: 12_500_000_000_030n,
    signerBalance: 50_000_000_000_000n,
    proofChecks: [{ variant: "01x01", valid: true, publicSignals: 4 }],
  };

  it("shows every address in full, the expected assets, and the sending order", () => {
    const text = describePlan(plan).join("\n");
    expect(text).toContain(`Signer (pays gas):    ${SIGNER}`);
    expect(text).toContain(`Redeem RECEIVER:      ${RECEIVER}`);
    expect(text).toContain("2.0 TOKEN");
    expect(text).toContain("less than 1.99 TOKEN");
    expect(text).toContain(`Tx 1: unshield  -> ${POOL}  nonce 4`);
    expect(text).toContain(`Tx 2: redeem    -> ${VAULT}  nonce 5`);
    expect(text).toContain("01x01 valid");
    expect(text).toContain("-> enough");
    expect(text).toContain("the redeem follows as soon as the unshield has 1 confirmation");
    expect(text).toContain("show up again in private-assets; run recover again");
  });

  it("flags a signer that cannot pay the maximum gas cost", () => {
    const short = { ...plan, signerBalance: 1n };
    expect(signerCanPayGas(plan)).toBe(true);
    expect(signerCanPayGas(short)).toBe(false);
    expect(describePlan(short).join("\n")).toContain("NOT ENOUGH");
  });
});
