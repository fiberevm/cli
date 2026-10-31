import {
  RailgunVersionedSmartContracts,
  TXIDVersion,
  TransactionBatch,
  WalletBalanceBucket,
  getTokenDataERC20,
} from "@railgun-community/engine";
import {
  Contract,
  Interface,
  Transaction,
  Wallet,
  formatEther,
  formatUnits,
  getAddress,
  hexlify,
  type JsonRpcProvider,
  type TransactionReceipt,
} from "ethers";
import { getRpcChainId, openRailgunWallet, type RailgunWalletSession } from "./private-assets.ts";
import { deriveEvmPrivateKey } from "./private-key.ts";
import { createVerifiedArtifactSource, type OnChainVerifyingKey } from "./proof-artifacts.ts";
import { attachProver, loadSnarkJs, type ProofCheck } from "./prover.ts";
import { GuardedSendProvider, describeRevert } from "./transaction-guards.ts";

const V2 = TXIDVersion.V2_PoseidonMerkle;
// Base is the only pool recover has been tested on end to end. Railgun's SDK configures Private Proof
// of Innocence on the other Fiber pools (Ethereum, BNB Smart Chain, Arbitrum, Polygon), which this
// command does not generate.
export const RECOVER_CHAIN_IDS: ReadonlySet<number> = new Set([8453]);
const BASIS_POINTS = 10_000n;
// OP Stack chains charge an L1 data fee on top of L2 gas; Base is the only Fiber private chain among them.
const OP_STACK_CHAIN_IDS = new Set([8453]);
const OP_STACK_GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";
const CONFIRMATIONS = 2;
// Before a redeem the unshield waits for one confirmation only: Fiber's backend can re-deposit tokens
// that land on its own accounts, so the redeem should follow as soon as possible. If the unshield
// were reorganized away, the redeem would simply revert.
const UNSHIELD_CONFIRMATIONS_BEFORE_REDEEM = 1;
const BALANCE_POLL_MS = 500;
const BALANCE_POLL_ATTEMPTS = 60;
const RECEIPT_TIMEOUT_MS = 10 * 60_000;
// Redeem is skipped when it would return more than 0.5% less than the simulation promised.
const REDEEM_TOLERANCE_BPS = 50n;

const POOL_ABI = [
  "function unshieldFee() view returns (uint120)",
  "function getVerificationKey(uint256 nullifiers, uint256 commitments) view returns (tuple(string artifactsIPFSHash, tuple(uint256 x, uint256 y) alpha1, tuple(uint256[2] x, uint256[2] y) beta2, tuple(uint256[2] x, uint256[2] y) gamma2, tuple(uint256[2] x, uint256[2] y) delta2, tuple(uint256 x, uint256 y)[] ic))",
];
const TOKEN_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function asset() view returns (address)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];
const token = new Interface(TOKEN_ABI);
const TRANSFER_TOPIC = token.getEvent("Transfer")!.topicHash;

type LogLike = { address: string; topics: readonly string[]; data: string };
export type SimulatedCall = { label: string; from: string; to: string; data: string };
export type SimulationResult = { label: string; ok: boolean; returnData: string; gasUsed?: bigint; error?: string; logs: LogLike[] };
export type StateOverrides = Record<string, { balance?: string; stateDiff?: Record<string, string> }>;

/** Sums Transfer(from -> to) amounts of one token in a list of logs; `from` is optional. */
export function sumTransfers(logs: readonly LogLike[], tokenAddress: string, to: string, from?: string): bigint {
  const topicAddress = (topic: string | undefined) => `0x${(topic ?? "").slice(26)}`.toLowerCase();
  return logs
    .filter((log) => log.address.toLowerCase() === tokenAddress.toLowerCase() && log.topics[0] === TRANSFER_TOPIC)
    .filter((log) => topicAddress(log.topics[2]) === to.toLowerCase())
    .filter((log) => !from || topicAddress(log.topics[1]) === from.toLowerCase())
    .reduce((total, log) => total + BigInt(log.data), 0n);
}

const rpcErrorText = (error: unknown) => {
  const fields = error as { error?: { message?: string }; shortMessage?: string; message?: string };
  return fields.error?.message ?? fields.shortMessage ?? fields.message ?? "unknown error";
};

/**
 * Runs calls in order on one simulated block with eth_simulateV1. Nothing is signed or sent;
 * validation is off, so the sender needs neither a signature nor gas money.
 */
export async function simulateCalls(provider: JsonRpcProvider, calls: SimulatedCall[], stateOverrides: StateOverrides = {}): Promise<SimulationResult[]> {
  let response: { calls: { status: string; returnData: string; gasUsed?: string; error?: { message?: string; data?: string }; logs?: LogLike[] }[] }[];
  try {
    response = await provider.send("eth_simulateV1", [
      {
        blockStateCalls: [{ stateOverrides, calls: calls.map(({ from, to, data }) => ({ from, to, data, gas: "0xe4e1c0" })) }],
        validation: false,
        traceTransfers: false,
      },
      "latest",
    ]);
  } catch (error) {
    throw new Error(`The RPC could not run eth_simulateV1, which recover requires before signing (${rpcErrorText(error)})`);
  }
  return response[0]!.calls.map((result, index) => ({
    label: calls[index]!.label,
    ok: result.status === "0x1",
    returnData: result.returnData,
    gasUsed: result.gasUsed ? BigInt(result.gasUsed) : undefined,
    error: result.status === "0x1" ? undefined : describeRevert(result.error?.data ?? result.returnData, result.error?.message),
    logs: result.logs ?? [],
  }));
}

export type PlannedTransaction = { label: string; to: string; data: string; gasLimit: bigint; gasSource: string; l1Fee: bigint };

export type RecoveryPlan = {
  chainId: number;
  networkName: string;
  pool: string;
  signer: string;
  token: string;
  tokenSymbol: string;
  tokenDecimals: number;
  /** Amount spent from the private balance. */
  amount: bigint;
  /** Amount that reaches the signer after the pool's unshield fee. */
  received: bigint;
  feeBasisPoints: bigint;
  redeem?: { receiver: string; asset: string; assetSymbol: string; assetDecimals: number; expectedAssets: bigint };
  /** In sending order: the unshield, then the optional redeem. */
  transactions: PlannedTransaction[];
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  maxCost: bigint;
  signerBalance: bigint;
  proofChecks: ProofCheck[];
};

const transactionCost = (transaction: PlannedTransaction, maxFeePerGas: bigint) =>
  transaction.gasLimit * maxFeePerGas + (transaction.l1Fee * 3n) / 2n;

export const signerCanPayGas = (plan: RecoveryPlan) => plan.signerBalance >= plan.maxCost;

async function erc20Metadata(provider: JsonRpcProvider, address: string) {
  const contract = new Contract(address, TOKEN_ABI, provider);
  const [symbol, decimals] = await Promise.all([
    contract.symbol().catch(() => "tokens") as Promise<string>,
    contract.decimals().then(Number).catch(() => 0) as Promise<number>,
  ]);
  return { symbol, decimals };
}

/** Gas limits, EIP-1559 fees, the OP Stack L1 fee, the nonce, and the signer's balance for a plan. */
async function planGas(provider: JsonRpcProvider, chainId: number, signer: string, calls: { label: string; to: string; data: string; simulatedGas?: bigint }[]) {
  const [nonce, confirmedNonce] = await Promise.all([
    provider.getTransactionCount(signer, "pending"),
    provider.getTransactionCount(signer, "latest"),
  ]);
  if (nonce !== confirmedNonce) {
    throw new Error(`${signer} has pending transactions (nonce ${confirmedNonce} confirmed, ${nonce} pending); wait for them to confirm`);
  }
  const fees = await provider.getFeeData();
  if (fees.maxFeePerGas == null || fees.maxPriorityFeePerGas == null) throw new Error("The RPC returned no EIP-1559 fee data");
  const oracle = OP_STACK_CHAIN_IDS.has(chainId)
    ? new Contract(OP_STACK_GAS_PRICE_ORACLE, ["function getL1Fee(bytes) view returns (uint256)"], provider)
    : undefined;

  const transactions: PlannedTransaction[] = [];
  for (const [index, call] of calls.entries()) {
    // Only the first call runs on today's state; later ones depend on it, so they use simulated gas.
    const estimated = index === 0
      ? await provider.estimateGas({ from: signer, to: call.to, data: call.data }).catch(() => undefined)
      : undefined;
    const base = [call.simulatedGas ?? 0n, estimated ?? 0n].reduce((left, right) => (left > right ? left : right));
    if (base === 0n) throw new Error(`Could not determine gas for ${call.label}`);
    const gasLimit = (base * 13n) / 10n;
    const unsigned = Transaction.from({
      type: 2, chainId, nonce: nonce + index, to: call.to, data: call.data, value: 0n,
      gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    }).unsignedSerialized;
    const l1Fee: bigint = oracle ? await oracle.getL1Fee(unsigned) : 0n;
    transactions.push({
      label: call.label, to: call.to, data: call.data, gasLimit, l1Fee,
      gasSource: estimated === undefined ? `simulated ${call.simulatedGas} x 1.3` : `max(simulated ${call.simulatedGas ?? "-"}, estimated ${estimated}) x 1.3`,
    });
  }
  return {
    transactions,
    nonce,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    maxCost: transactions.reduce((total, transaction) => total + transactionCost(transaction, fees.maxFeePerGas!), 0n),
  };
}

/** Rejects chains recover does not support, before any scan or signing. */
export function assertRecoverChain(chainId: number): void {
  if (!RECOVER_CHAIN_IDS.has(chainId)) {
    throw new Error(
      `recover is available only on Base (8453); this RPC is on chain ${chainId}. ` +
        "Use private-assets to check private balances on other chains.",
    );
  }
}

/** Sums the spendable private balance of one ERC-20 across transaction versions. */
export async function spendablePrivateBalance(session: RailgunWalletSession, tokenAddress: string): Promise<bigint> {
  const balances = await session.wallet.getTokenBalancesAllTxidVersions(session.network.chain, [WalletBalanceBucket.Spendable]);
  let total = 0n;
  for (const byToken of Object.values(balances)) {
    for (const balance of Object.values(byToken)) {
      const address = `0x${balance.tokenData.tokenAddress.replace(/^0x/i, "").slice(-40)}`;
      if (address.toLowerCase() === tokenAddress.toLowerCase()) total += balance.balance;
    }
  }
  return total;
}

/**
 * Builds and proves the unshield to the signer, simulates it (and the optional ERC-4626 redeem)
 * with eth_simulateV1 on one block, checks the resulting Transfer logs, and prices the gas.
 * It throws, without signing anything, if any simulated step fails.
 * `simulationPrefix`, `stateOverrides`, and `signerBalance` exist for tests and dry runs.
 */
export async function prepareRecovery(
  session: RailgunWalletSession,
  options: {
    signer: string;
    token: string;
    amount: bigint;
    redeemTo?: string;
    proofChecks: ProofCheck[];
    onProgress?: (message: string) => void;
    simulationPrefix?: SimulatedCall[];
    stateOverrides?: StateOverrides;
    signerBalance?: bigint;
  },
): Promise<RecoveryPlan> {
  const { signer, amount, redeemTo, proofChecks, onProgress = () => undefined, simulationPrefix = [] } = options;
  assertRecoverChain(session.chainId);
  if (session.network.poi) throw new Error(`recover does not generate Private POI proofs, which ${session.network.publicName} uses`);
  const provider = session.provider;
  const poolAddress = getAddress(session.network.proxyContract);
  const pool = new Contract(poolAddress, POOL_ABI, provider);

  onProgress("Generating the unshield proof (this can take a minute)...");
  const batch = new TransactionBatch(session.network.chain);
  batch.addUnshieldData({ toAddress: signer, value: amount, tokenData: getTokenDataERC20(options.token) });
  const { provedTransactions } = await batch.generateTransactions(
    session.engine.prover,
    session.wallet,
    V2,
    session.encryptionKey,
    () => undefined,
    false,
  );
  const transact = await RailgunVersionedSmartContracts.generateTransact(V2, session.network.chain, provedTransactions);
  if (!transact.to || getAddress(transact.to) !== poolAddress || !transact.data) {
    throw new Error(`The unshield transaction targets ${transact.to}, not the pool ${poolAddress}`);
  }

  const feeBasisPoints = BigInt(await pool.unshieldFee());
  const received = amount - (amount * feeBasisPoints) / BASIS_POINTS;
  const calls: SimulatedCall[] = [{ label: "unshield", from: signer, to: poolAddress, data: transact.data }];
  let redeemAsset: string | undefined;
  if (redeemTo) {
    redeemAsset = await new Contract(options.token, TOKEN_ABI, provider).asset().catch(() => undefined);
    if (!redeemAsset) throw new Error("--redeem-to requires --token to be an ERC-4626 vault, but asset() failed");
    calls.push({ label: "redeem", from: signer, to: options.token, data: token.encodeFunctionData("redeem", [received, redeemTo, signer]) });
  }

  const results = await simulateCalls(provider, [...simulationPrefix, ...calls], options.stateOverrides);
  const prefixFailure = results.slice(0, simulationPrefix.length).find((result) => !result.ok);
  if (prefixFailure) throw new Error(`Simulation setup call ${prefixFailure.label} failed: ${prefixFailure.error}`);
  const [unshield, redeem] = results.slice(simulationPrefix.length);

  const problems: string[] = [];
  if (!unshield!.ok) problems.push(`unshield: ${unshield!.error}`);
  const unshielded = unshield!.ok ? sumTransfers(unshield!.logs, options.token, signer, poolAddress) : 0n;
  if (unshield!.ok && unshielded !== received) problems.push(`unshield moved ${unshielded} to the signer, expected ${received}`);
  let expectedAssets = 0n;
  if (redeem) {
    if (!redeem.ok) problems.push(`redeem: ${redeem.error}`);
    else {
      expectedAssets = token.decodeFunctionResult("redeem", redeem.returnData)[0] as bigint;
      const delivered = sumTransfers(redeem.logs, redeemAsset!, redeemTo!);
      if (expectedAssets === 0n || delivered !== expectedAssets) problems.push(`redeem returns ${expectedAssets} but transfers ${delivered} to the receiver`);
    }
  }
  if (problems.length > 0) throw new Error(`Simulation failed; nothing was signed:\n  - ${problems.join("\n  - ")}`);

  const gas = await planGas(provider, session.chainId, signer, calls.map((call, index) => ({
    ...call,
    simulatedGas: results[simulationPrefix.length + index]!.gasUsed,
  })));
  const tokenMetadata = await erc20Metadata(provider, options.token);
  const assetMetadata = redeemAsset ? await erc20Metadata(provider, redeemAsset) : undefined;
  return {
    chainId: session.chainId,
    networkName: session.network.publicName,
    pool: poolAddress,
    signer,
    token: getAddress(options.token),
    tokenSymbol: tokenMetadata.symbol,
    tokenDecimals: tokenMetadata.decimals,
    amount,
    received,
    feeBasisPoints,
    redeem: redeemTo && assetMetadata
      ? { receiver: redeemTo, asset: getAddress(redeemAsset!), assetSymbol: assetMetadata.symbol, assetDecimals: assetMetadata.decimals, expectedAssets }
      : undefined,
    ...gas,
    signerBalance: options.signerBalance ?? (await provider.getBalance(signer)),
    proofChecks: [...proofChecks],
  };
}

/** Writes the plan that the user confirms: every address in full, amounts, gas, and the order. */
export function describePlan(plan: RecoveryPlan): string[] {
  const tokens = (value: bigint) => `${formatUnits(value, plan.tokenDecimals)} ${plan.tokenSymbol}`;
  const lines = [
    "",
    "================ RECOVERY PLAN: these transactions will be SIGNED and SENT ================",
    `Network:              ${plan.networkName} (${plan.chainId})`,
    `Signer (pays gas):    ${plan.signer}`,
    `Unshield:             ${tokens(plan.amount)} of ${plan.token} from pool ${plan.pool}`,
    `Unshield fee:         ${plan.feeBasisPoints} bps -> signer receives ${tokens(plan.received)}`,
    `Local proof checks:   ${plan.proofChecks.map((check) => `${check.variant} ${check.valid ? "valid" : "INVALID"}`).join(", ") || "none"}`,
  ];
  if (plan.redeem) {
    const assets = (value: bigint) => `${formatUnits(value, plan.redeem!.assetDecimals)} ${plan.redeem!.assetSymbol}`;
    const minimum = (plan.redeem.expectedAssets * (BASIS_POINTS - REDEEM_TOLERANCE_BPS)) / BASIS_POINTS;
    lines.push(
      `Redeem RECEIVER:      ${plan.redeem.receiver}`,
      `Expected ${plan.redeem.assetSymbol}:`.padEnd(22) + `${assets(plan.redeem.expectedAssets)} (redeem is not sent if it would return less than ${assets(minimum)})`,
    );
  }
  plan.transactions.forEach((transaction, index) => {
    lines.push(
      `Tx ${index + 1}: ${transaction.label.padEnd(9)} -> ${transaction.to}  nonce ${plan.nonce + index}  gas limit ${transaction.gasLimit} [${transaction.gasSource}]` +
        (transaction.l1Fee > 0n ? `  L1 fee ~${formatEther(transaction.l1Fee)} ETH` : ""),
    );
  });
  lines.push(
    `Fees:                 max ${formatUnits(plan.maxFeePerGas, 9)} gwei, priority ${formatUnits(plan.maxPriorityFeePerGas, 9)} gwei`,
    `Maximum gas cost:     ${formatEther(plan.maxCost)} (native token; the actual cost is usually lower)`,
    `Signer balance:       ${formatEther(plan.signerBalance)} -> ${signerCanPayGas(plan) ? "enough" : `NOT ENOUGH (${formatEther(plan.maxCost - plan.signerBalance)} short)`}`,
  );
  if (plan.redeem) {
    lines.push(
      `Order: the unshield is sent first; the redeem follows as soon as the unshield has ${UNSHIELD_CONFIRMATIONS_BEFORE_REDEEM} confirmation.`,
      "If Fiber re-deposits the unshielded tokens first, they show up again in private-assets; run recover again.",
    );
  }
  lines.push("===========================================================================================");
  return lines;
}

export type RecoveryResult = {
  steps: { label: string; hash: string; block: number; gasUsed: bigint }[];
  received?: bigint;
  assetsReceived?: bigint;
};

/**
 * Sends a confirmed plan: the unshield first, then (after one confirmation and a log check) the redeem.
 * Before each send it re-runs the call on current state with eth_call and rechecks the balance.
 */
export async function executeRecovery({
  plan,
  readProvider,
  sendProvider,
  signer,
  onProgress = () => undefined,
}: {
  plan: RecoveryPlan;
  readProvider: JsonRpcProvider;
  sendProvider: GuardedSendProvider;
  signer: Wallet;
  onProgress?: (message: string) => void;
}): Promise<RecoveryResult> {
  if (getAddress(signer.address) !== plan.signer || sendProvider.signer !== plan.signer) throw new Error("The signer does not match the plan");
  for (const transaction of plan.transactions) sendProvider.allow(transaction.to, transaction.data, transaction.label);
  const connected = signer.connect(sendProvider);
  const result: RecoveryResult = { steps: [] };
  let nonce = plan.nonce;

  const send = async (transaction: PlannedTransaction, confirmations: number): Promise<TransactionReceipt> => {
    try {
      await readProvider.call({ from: plan.signer, to: transaction.to, data: transaction.data });
    } catch (error) {
      const data = (error as { data?: string }).data;
      throw new Error(`${transaction.label} would revert now (${describeRevert(data, rpcErrorText(error))}); it was not sent`);
    }
    const fees = await readProvider.getFeeData();
    const maxFeePerGas = fees.maxFeePerGas != null && fees.maxFeePerGas > plan.maxFeePerGas ? fees.maxFeePerGas : plan.maxFeePerGas;
    const balance = await readProvider.getBalance(plan.signer);
    if (balance < transactionCost(transaction, maxFeePerGas)) {
      throw new Error(`Not enough balance for ${transaction.label} gas: ${formatEther(balance)} available, up to ${formatEther(transactionCost(transaction, maxFeePerGas))} needed`);
    }

    const response = await connected.sendTransaction({
      type: 2, chainId: plan.chainId, nonce, to: transaction.to, data: transaction.data, value: 0n,
      gasLimit: transaction.gasLimit, maxFeePerGas, maxPriorityFeePerGas: plan.maxPriorityFeePerGas,
    });
    nonce += 1;
    onProgress(`${transaction.label}: sent ${response.hash}; waiting for ${confirmations} confirmation(s)...`);
    let receipt: TransactionReceipt | null;
    try {
      receipt = await sendProvider.waitForTransaction(response.hash, confirmations, RECEIPT_TIMEOUT_MS);
    } catch (error) {
      throw new Error(`Could not confirm ${transaction.label} ${response.hash} (${rpcErrorText(error)}); check it in a block explorer before retrying`);
    }
    if (!receipt) throw new Error(`${transaction.label} ${response.hash} was not confirmed in time; check it in a block explorer before retrying`);
    if (receipt.status !== 1) throw new Error(`${transaction.label} ${response.hash} reverted on-chain`);
    onProgress(`${transaction.label}: confirmed in block ${receipt.blockNumber} (gas used ${receipt.gasUsed})`);
    result.steps.push({ label: transaction.label, hash: response.hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed });
    return receipt;
  };

  const unshieldReceipt = await send(
    plan.transactions[0]!,
    plan.redeem ? UNSHIELD_CONFIRMATIONS_BEFORE_REDEEM : CONFIRMATIONS,
  );
  result.received = sumTransfers(unshieldReceipt.logs, plan.token, plan.signer, plan.pool);
  if (!plan.redeem) return result;

  const leftover =
    `If the unshielded tokens are still in ${plan.signer}, redeem them later from any wallet that holds this account's key. ` +
    "If they are gone, Fiber may have re-deposited them into your private balance: check with private-assets and run recover again.";
  if (result.received !== plan.received) {
    throw new Error(`The unshield confirmed but moved ${result.received} instead of ${plan.received}; the redeem was not sent. ${leftover}`);
  }
  try {
    // The read RPC can lag the broadcast RPC by a block; wait until it sees the unshielded balance.
    const vault = new Contract(plan.token, TOKEN_ABI, readProvider);
    for (let attempt = 0; (await vault.balanceOf(plan.signer)) < plan.received; attempt += 1) {
      if (attempt >= BALANCE_POLL_ATTEMPTS) throw new Error("the read RPC does not show the unshielded balance in the signer account");
      await new Promise((resolve) => setTimeout(resolve, BALANCE_POLL_MS));
    }
    const redeem = plan.transactions[1]!;
    const returned = token.decodeFunctionResult("redeem", await readProvider.call({ from: plan.signer, to: redeem.to, data: redeem.data }))[0] as bigint;
    const minimum = (plan.redeem.expectedAssets * (BASIS_POINTS - REDEEM_TOLERANCE_BPS)) / BASIS_POINTS;
    if (returned < minimum) throw new Error(`redeem would return ${returned}, below the minimum ${minimum}`);
    const redeemReceipt = await send(redeem, CONFIRMATIONS);
    result.assetsReceived = sumTransfers(redeemReceipt.logs, plan.redeem.asset, plan.redeem.receiver);
    return result;
  } catch (error) {
    throw new Error(`${(error as Error).message}. ${leftover}`);
  }
}

export type RecoverInput = {
  seed: Uint8Array;
  rpcUrl: string;
  chunkSize?: number;
  token: string;
  amount?: bigint;
  derivationIndex: number;
  redeemTo?: string;
  artifactsDirectory?: string;
  dryRun: boolean;
  confirm: () => Promise<boolean>;
  onProgress: (message: string) => void;
  output: (line: string) => void;
};

export type RecoverOutcome = "completed" | "dry-run" | "cancelled";

/**
 * The recover command: scan, prove, simulate, show the plan, ask for confirmation, then send.
 * The signer is the EVM account at the given derivation index; its key never leaves this process.
 */
export async function runRecovery(input: RecoverInput): Promise<RecoverOutcome> {
  // Checked first so an unsupported chain fails before a long scan.
  assertRecoverChain(await getRpcChainId(input.rpcUrl));
  const keyBytes = deriveEvmPrivateKey(input.seed, input.derivationIndex);
  let signer: Wallet;
  try {
    signer = new Wallet(hexlify(keyBytes));
  } finally {
    keyBytes.fill(0);
  }
  input.onProgress(`Signer (derivation index ${input.derivationIndex}): ${signer.address}`);

  const proofChecks: ProofCheck[] = [];
  let session: RailgunWalletSession | undefined;
  let proverReady: Promise<void> | undefined;
  const artifacts = createVerifiedArtifactSource({
    getOnChainVerifyingKey: async (nullifiers, commitments) => {
      const pool = new Contract(session!.network.proxyContract, POOL_ABI, session!.provider);
      return (await pool.getVerificationKey(nullifiers, commitments)) as OnChainVerifyingKey;
    },
    exportVerificationKey: async (zkey) => (await loadSnarkJs()).zKey.exportVerificationKey(zkey),
    cacheDirectory: input.artifactsDirectory,
    log: input.onProgress,
  });

  let sendProvider: GuardedSendProvider | undefined;
  try {
    session = await openRailgunWallet({
      seed: input.seed,
      rpcUrl: input.rpcUrl,
      chunkSize: input.chunkSize,
      onProgress: input.onProgress,
      artifactGetter: artifacts.getter,
      onEngineReady: (engine) => {
        proverReady = attachProver(engine, artifacts.variantOf, (check) => {
          proofChecks.push(check);
          input.onProgress(`Local Groth16 verification (${check.variant}): ${check.valid ? "valid" : "INVALID"}`);
        });
      },
    });
    await proverReady;

    const spendable = await spendablePrivateBalance(session, input.token);
    const amount = input.amount ?? spendable;
    if (amount === 0n) throw new Error(`No spendable private balance of ${input.token}; nothing to recover`);
    if (amount > spendable) throw new Error(`--amount ${amount} exceeds the spendable private balance ${spendable}`);

    const plan = await prepareRecovery(session, {
      signer: signer.address,
      token: input.token,
      amount,
      redeemTo: input.redeemTo,
      proofChecks,
      onProgress: input.onProgress,
    });
    for (const line of describePlan(plan)) input.output(line);
    if (input.dryRun) {
      input.output("Dry run: nothing was signed or sent.");
      return "dry-run";
    }
    if (!signerCanPayGas(plan)) {
      throw new Error(`The signer needs at least ${formatEther(plan.maxCost - plan.signerBalance)} more for gas on ${plan.networkName}; nothing was signed`);
    }
    if (!(await input.confirm())) {
      input.output("Cancelled: nothing was signed or sent.");
      return "cancelled";
    }

    sendProvider = new GuardedSendProvider(input.rpcUrl, plan.chainId, plan.signer);
    const result = await executeRecovery({ plan, readProvider: session.provider, sendProvider, signer, onProgress: input.onProgress });
    input.output("");
    for (const step of result.steps) input.output(`${step.label.padEnd(9)} block ${step.block}  gas ${step.gasUsed}  tx ${step.hash}`);
    if (result.received !== undefined) input.output(`Unshielded to ${plan.signer}: ${formatUnits(result.received, plan.tokenDecimals)} ${plan.tokenSymbol}`);
    if (plan.redeem && result.assetsReceived !== undefined) {
      input.output(`Redeemed to ${plan.redeem.receiver}: ${formatUnits(result.assetsReceived, plan.redeem.assetDecimals)} ${plan.redeem.assetSymbol}`);
    }
    return "completed";
  } finally {
    sendProvider?.destroy();
    await session?.close();
  }
}
