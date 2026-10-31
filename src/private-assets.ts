import { randomBytes } from "node:crypto";
import {
  EngineEvent,
  MerkletreeScanStatus,
  RailgunEngine,
  TokenType,
  TXIDVersion,
  WalletBalanceBucket,
  type MerkletreeHistoryScanEventData,
  type RailgunWallet,
  type TokenBalancesAllTxidVersions,
  type UTXOScanDecryptBalancesCompleteEventData,
} from "@railgun-community/engine";
import { NETWORK_CONFIG, type Network } from "@railgun-community/shared-models";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import memdown from "memdown";
import { getFiberEvmChain, getFiberPrivateDeployment } from "./chains.ts";
import { LogRangeProvider, isRangeLimitError } from "./log-range-provider.ts";

export type PrivateAsset = {
  type: "ERC20" | "ERC721" | "ERC1155";
  address: string;
  tokenId: string | null;
  rawAmount: string;
};

export type PrivateAssetScan = {
  chainId: number;
  network: string;
  assets: PrivateAsset[];
};

const TOKEN_TYPE_NAMES: Record<TokenType, PrivateAsset["type"]> = {
  [TokenType.ERC20]: "ERC20",
  [TokenType.ERC721]: "ERC721",
  [TokenType.ERC1155]: "ERC1155",
};

/** Marks a scan that could not read the pool's full history, so balances are unknown. */
class IncompletePrivateAssetScanError extends Error {}

/**
 * Validates an explicit HTTP RPC URL before any wallet material is decrypted or scanned.
 * It accepts only a CLI-provided value and never consults environment variables.
 */
export function validateRpcUrl(rpcUrl: string): void {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rpcUrl);
  } catch {
    throw new Error("--rpc-url must be a valid URL");
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new Error("--rpc-url must use http or https");
  }
}

/**
 * Queries the supplied endpoint for its chain ID without trying a secondary provider.
 * It accepts one validated RPC URL and rejects malformed or timed-out responses.
 */
export async function getRpcChainId(rpcUrl: string): Promise<number> {
  validateRpcUrl(rpcUrl);
  let response: Response;
  try {
    response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Do not echo an RPC URL because it can contain a provider credential.
    throw new Error("Could not connect to the supplied RPC");
  }
  if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}`);

  const payload = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (typeof payload.result !== "string" || !/^0x[0-9a-f]+$/i.test(payload.result)) {
    throw new Error(payload.error?.message ? "RPC rejected eth_chainId" : "RPC returned an invalid chain ID");
  }

  const chainId = Number.parseInt(payload.result.slice(2), 16);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("RPC returned an invalid chain ID");
  return chainId;
}

/**
 * Combines SDK chain capabilities with Fiber's deployment for read-only recovery.
 * It accepts the RPC-reported chain ID and excludes deprecated or empty SDK networks.
 */
export function getRailgunNetwork(chainId: number): Network {
  const fiberChain = getFiberEvmChain(chainId);
  if (!fiberChain) {
    throw new Error(`Chain ${chainId} is not supported by Fiber`);
  }
  if (!fiberChain.privateAssets) {
    throw new Error(`Fiber private assets are not available on ${fiberChain.name} (${chainId})`);
  }

  const network = Object.values(NETWORK_CONFIG).find(
    (candidate) =>
      candidate.chain.id === chainId &&
      !candidate.deprecated &&
      candidate.proxyContract.length > 0,
  );
  if (!network) throw new Error(`Railgun private assets are not supported on chain ${chainId}`);

  const fiberDeployment = getFiberPrivateDeployment(chainId);
  if (!fiberDeployment) return network;

  // The SDK still lists upstream Arbitrum. Read Fiber's proxy and full history instead.
  return {
    ...network,
    proxyContract: fiberDeployment.proxy,
    deploymentBlock: fiberDeployment.deploymentBlock,
  };
}

/**
 * Combines positive spendable balances across active Railgun transaction versions.
 * It accepts the engine's per-version balance map and retains every supported asset type.
 */
export function aggregatePrivateAssets(
  balancesByVersion: TokenBalancesAllTxidVersions,
): PrivateAsset[] {
  const assetsByIdentifier = new Map<string, PrivateAsset>();

  for (const tokenBalances of Object.values(balancesByVersion)) {
    for (const treeBalance of Object.values(tokenBalances)) {
      if (treeBalance.balance <= 0n) continue;

      const tokenType = TOKEN_TYPE_NAMES[treeBalance.tokenData.tokenType];
      if (!tokenType) continue;
      const addressHex = treeBalance.tokenData.tokenAddress.replace(/^0x/i, "").slice(-40);
      const address = `0x${addressHex.toLowerCase()}`;
      const tokenId = tokenType === "ERC20" ? null : BigInt(treeBalance.tokenData.tokenSubID).toString();
      const identifier = `${tokenType}:${address}:${tokenId ?? ""}`;
      const existingAsset = assetsByIdentifier.get(identifier);

      assetsByIdentifier.set(identifier, {
        type: tokenType,
        address,
        tokenId,
        rawAmount: (BigInt(existingAsset?.rawAmount ?? 0) + treeBalance.balance).toString(),
      });
    }
  }

  return [...assetsByIdentifier.values()].sort((left, right) =>
    `${left.type}:${left.address}:${left.tokenId ?? ""}`.localeCompare(
      `${right.type}:${right.address}:${right.tokenId ?? ""}`,
    ),
  );
}

export type ArtifactGetter = Parameters<typeof RailgunEngine.initForWallet>[2];

const unavailableArtifacts = {
  assertArtifactExists: () => undefined,
  getArtifacts: async () => {
    throw new Error("Proof artifacts are not available in the read-only Fiber CLI");
  },
  getArtifactsPOI: async () => {
    throw new Error("POI proof artifacts are not available in the read-only Fiber CLI");
  },
} as unknown as ArtifactGetter;

/** A fully scanned in-memory Railgun wallet. close() unloads the engine and clears the session key. */
export type RailgunWalletSession = {
  chainId: number;
  network: Network;
  engine: RailgunEngine;
  wallet: RailgunWallet;
  provider: LogRangeProvider;
  /** Random per-session key that encrypts the in-memory wallet database. */
  encryptionKey: string;
  close: () => Promise<void>;
};

/**
 * Says why a history scan stopped: an RPC that rejects the block range needs a smaller --chunk,
 * while one that answers recent blocks but refuses old ones keeps no history, and --chunk cannot help.
 */
async function explainIncompleteScan(
  provider: LogRangeProvider,
  poolAddress: string,
  deploymentBlock: number,
): Promise<string> {
  const failure = provider.lastLogFailure;
  if (failure?.rpcError && isRangeLimitError(failure.rpcError)) {
    return "The RPC rejected the eth_getLogs block range; retry with a smaller --chunk (for example --chunk 100).";
  }
  if (failure) {
    let servesRecentLogs = false;
    try {
      const latest = await provider.getBlockNumber();
      await provider.send("eth_getLogs", [
        { address: poolAddress, fromBlock: `0x${Math.max(0, latest - 9).toString(16)}`, toBlock: `0x${latest.toString(16)}` },
      ]);
      servesRecentLogs = true;
    } catch {
      // The RPC refuses even recent logs; fall through to the general advice.
    }
    if (servesRecentLogs) {
      const reason = failure.rpcError ? ` (${failure.rpcError.message.slice(0, 160)})` : "";
      return (
        `The RPC answers eth_getLogs for recent blocks but refused block ${failure.fromBlock}${reason}, ` +
        "so it does not serve the pool's older logs and a smaller --chunk will not help. " +
        `Use an RPC that serves eth_getLogs back to block ${deploymentBlock}; many free plans keep only recent logs.`
      );
    }
  }
  return (
    "Use an RPC that serves eth_getLogs back to the pool's deployment; many free public RPCs refuse this. " +
    "If the RPC only limits the block range, retry with a smaller --chunk (for example --chunk 100)."
  );
}

/**
 * Reconstructs Fiber's Railgun wallet and scans its full history through one explicit RPC.
 * It accepts decrypted seed bytes, the RPC URL, an optional eth_getLogs block span, a progress
 * sink, and a proof-artifact source (read-only by default). It throws when the scan cannot read
 * the pool's full history. Callers must call close() on the returned session.
 */
export async function openRailgunWallet({
  seed,
  rpcUrl,
  chunkSize,
  onProgress = () => undefined,
  artifactGetter = unavailableArtifacts,
  onEngineReady = () => undefined,
}: {
  seed: Uint8Array;
  rpcUrl: string;
  chunkSize?: number;
  onProgress?: (message: string) => void;
  artifactGetter?: ArtifactGetter;
  /** Runs after engine creation and before the scan, for example to attach a prover. */
  onEngineReady?: (engine: RailgunEngine) => void;
}): Promise<RailgunWalletSession> {
  const chainId = await getRpcChainId(rpcUrl);
  const network = getRailgunNetwork(chainId);
  const encryptionKeyBytes = randomBytes(32);
  let engine: RailgunEngine | undefined;
  let provider: LogRangeProvider | undefined;
  const close = async () => {
    encryptionKeyBytes.fill(0);
    if (engine) await engine.unload().catch(() => undefined);
    provider?.destroy();
  };

  try {
    // Empty quick-sync callbacks keep recovery traffic on the user-supplied RPC.
    engine = await RailgunEngine.initForWallet(
      "fibercli",
      // Recovery state stays in this process and never touches the filesystem.
      memdown(),
      artifactGetter,
      async () => ({ commitmentEvents: [], unshieldEvents: [], nullifierEvents: [] }),
      async () => [],
      async () => true,
      async () => ({ txidIndex: undefined, merkleroot: undefined }),
      undefined,
      false,
    );
    onEngineReady(engine);

    onProgress(`Scanning ${network.publicName} through the supplied RPC; the first scan can take time...`);
    // Free RPCs often cap eth_getLogs ranges and rate-limit requests; this provider splits and retries.
    provider = new LogRangeProvider(rpcUrl, chainId, 10_000, {
      maxBlockRange: chunkSize,
      onRangeReduced: (blocks) =>
        onProgress(`The RPC limits eth_getLogs ranges; continuing with ${blocks}-block queries...`),
    });
    const deploymentBlocks = {
      [TXIDVersion.V2_PoseidonMerkle]: network.deploymentBlock,
      [TXIDVersion.V3_PoseidonMerkle]:
        network.deploymentBlockPoseidonMerkleAccumulatorV3 ?? 0,
    };
    const loadNetwork = engine.loadNetwork.bind(engine) as (...args: unknown[]) => Promise<void>;
    const networkArguments = [
      network.chain,
      network.proxyContract,
      network.relayAdaptContract,
      network.poseidonMerkleAccumulatorV3Contract,
      network.poseidonMerkleVerifierV3Contract,
      network.tokenVaultV3Contract,
      provider,
      provider,
      deploymentBlocks,
    ];

    // Railgun 9.6 added the POI launch block before the V3 capability flag.
    if (engine.loadNetwork.length >= 11) {
      await loadNetwork(...networkArguments, network.poi?.launchBlock, network.supportsV3);
    } else {
      await loadNetwork(...networkArguments, network.supportsV3);
    }

    const mnemonic = entropyToMnemonic(seed, wordlist);
    const creationBlockNumbers: number[][] = [];
    creationBlockNumbers[network.chain.type] ??= [];
    creationBlockNumbers[network.chain.type][network.chain.id] = network.deploymentBlock;

    const encryptionKey = encryptionKeyBytes.toString("hex");
    const wallet = (await engine.createWalletFromMnemonic(
      encryptionKey,
      mnemonic,
      0,
      creationBlockNumbers,
    )) as RailgunWallet;

    // The engine reports a failed history scan only as an event and then returns normally.
    // Without these checks, an RPC that refuses old logs would read as an empty wallet.
    const completedVersions = new Set<TXIDVersion>();
    let scanIncomplete = false;
    engine.on(
      EngineEvent.UTXOScanDecryptBalancesComplete,
      ({ txidVersion, chain }: UTXOScanDecryptBalancesCompleteEventData) => {
        if (chain.id === chainId) completedVersions.add(txidVersion);
      },
    );
    engine.on(
      EngineEvent.UTXOMerkletreeHistoryScanUpdate,
      ({ scanStatus, chain }: MerkletreeHistoryScanEventData) => {
        if (chain.id === chainId && scanStatus === MerkletreeScanStatus.Incomplete) {
          scanIncomplete = true;
        }
      },
    );
    await engine.scanContractHistory(network.chain, [wallet.id]);

    const scannedVersions = network.supportsV3
      ? [TXIDVersion.V2_PoseidonMerkle, TXIDVersion.V3_PoseidonMerkle]
      : [TXIDVersion.V2_PoseidonMerkle];
    if (scanIncomplete || scannedVersions.some((version) => !completedVersions.has(version))) {
      throw new IncompletePrivateAssetScanError(
        `Private asset scan on ${network.publicName} stopped before reading the pool's full history, so no balances are shown. ` +
          (await explainIncompleteScan(provider, network.proxyContract, network.deploymentBlock)),
      );
    }

    return { chainId, network, engine, wallet, provider, encryptionKey, close };
  } catch (error) {
    await close();
    if (error instanceof IncompletePrivateAssetScanError) throw error;
    throw new Error(
      `Private asset scan failed on ${network.publicName}; verify the supplied RPC and try again`,
    );
  }
}

/**
 * Reconstructs Fiber's Railgun wallet and scans private holdings through one explicit RPC.
 * It accepts decrypted seed bytes, the RPC URL, an optional eth_getLogs block span, and an
 * optional progress sink for stderr.
 */
export async function listPrivateAssets(input: {
  seed: Uint8Array;
  rpcUrl: string;
  chunkSize?: number;
  onProgress?: (message: string) => void;
}): Promise<PrivateAssetScan> {
  const session = await openRailgunWallet(input);
  try {
    const balances = await session.wallet.getTokenBalancesAllTxidVersions(
      session.network.chain,
      [WalletBalanceBucket.Spendable],
    );
    return {
      chainId: session.chainId,
      network: session.network.publicName,
      assets: aggregatePrivateAssets(balances),
    };
  } finally {
    await session.close();
  }
}
