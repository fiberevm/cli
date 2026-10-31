import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { ARTIFACT_V2_HASHES } from "./artifact-hashes.ts";
import type { ArtifactGetter } from "./private-assets.ts";

/** Railgun's official artifact bundle: the IPFS path that @railgun-community/wallet 11.3.0 downloads. */
export const OFFICIAL_ARTIFACT_BASE_URL =
  "https://ipfs-lb.com/ipfs/QmUsmnK4PFc7zDp2cmC4wBZxYLjNyRgWfs5GNcJJ2uLcpU";

export type SnarkJsVerifyingKey = Record<string, unknown> & {
  nPublic: number;
  vk_alpha_1: string[];
  vk_beta_2: string[][];
  vk_gamma_2: string[][];
  vk_delta_2: string[][];
  IC: string[][];
};

type G1 = { x: bigint; y: bigint };
type G2 = { x: readonly bigint[]; y: readonly bigint[] };
/** The shape returned by the pool's getVerificationKey(nullifiers, commitments). */
export type OnChainVerifyingKey = { alpha1: G1; beta2: G2; gamma2: G2; delta2: G2; ic: readonly G1[] };

export type VerifiedArtifacts = { zkey: Uint8Array; wasm: Uint8Array; vkey: SnarkJsVerifyingKey };

/** Formats a circuit variant name such as 01x02 (nullifiers x commitments). */
export function artifactVariant(nullifiers: number, commitments: number): string {
  return `${String(nullifiers).padStart(2, "0")}x${String(commitments).padStart(2, "0")}`;
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Fields where two snarkjs verifying keys differ (protocol and curve labels are ignored). */
export function verifyingKeyDifferences(left: Record<string, unknown>, right: Record<string, unknown>): string[] {
  return ["nPublic", "vk_alpha_1", "vk_beta_2", "vk_gamma_2", "vk_delta_2", "IC"].filter(
    (field) => JSON.stringify(left[field]) !== JSON.stringify(right[field]),
  );
}

const sameG1 = (onChain: G1, official: string[] | undefined) =>
  official !== undefined && onChain.x === BigInt(official[0]!) && onChain.y === BigInt(official[1]!);

// snarkjs writes G2 as [[x0, x1], [y0, y1]]; Solidity verifiers usually store [x1, x0] for the pairing precompile.
const sameG2 = (onChain: G2, official: string[][]) => {
  const [x0, x1] = official[0]!.map(BigInt);
  const [y0, y1] = official[1]!.map(BigInt);
  const direct = onChain.x[0] === x0 && onChain.x[1] === x1 && onChain.y[0] === y0 && onChain.y[1] === y1;
  const swapped = onChain.x[0] === x1 && onChain.x[1] === x0 && onChain.y[0] === y1 && onChain.y[1] === y0;
  return direct || swapped;
};

/** Fields where the pool's on-chain verifying key differs from an official snarkjs verifying key. */
export function onChainKeyDifferences(onChain: OnChainVerifyingKey, official: SnarkJsVerifyingKey): string[] {
  const differences: string[] = [];
  if (!sameG1(onChain.alpha1, official.vk_alpha_1)) differences.push("alpha1");
  if (!sameG2(onChain.beta2, official.vk_beta_2)) differences.push("beta2");
  if (!sameG2(onChain.gamma2, official.vk_gamma_2)) differences.push("gamma2");
  if (!sameG2(onChain.delta2, official.vk_delta_2)) differences.push("delta2");
  if (onChain.ic.length !== official.IC.length) {
    differences.push(`ic length ${onChain.ic.length} != ${official.IC.length}`);
  } else {
    onChain.ic.forEach((point, index) => {
      if (!sameG1(point, official.IC[index])) differences.push(`ic[${index}]`);
    });
  }
  return differences;
}

async function fetchWithRetry(url: string): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
      if (attempt >= 4) throw new Error(`HTTP ${response.status} from ${url}`);
    } catch (error) {
      if (attempt >= 4) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
  }
}

export type ArtifactSourceOptions = {
  /** Reads the pool's verifying key for one circuit variant. */
  getOnChainVerifyingKey: (nullifiers: number, commitments: number) => Promise<OnChainVerifyingKey>;
  /** snarkjs.zKey.exportVerificationKey, injected so the heavy library loads only when proving. */
  exportVerificationKey: (zkey: Uint8Array) => Promise<Record<string, unknown>>;
  /** Optional directory that caches verified, decompressed artifacts between runs. */
  cacheDirectory?: string;
  baseUrl?: string;
  hashes?: Record<string, { zkey: string; wasm: string }>;
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  log?: (message: string) => void;
};

/**
 * Downloads Railgun proof artifacts and accepts a circuit variant only after three checks:
 * the zkey and wasm match the SHA-256 published by Railgun's SDK, the verifying key inside the
 * zkey equals the official vkey.json, and that vkey.json equals the key stored in the pool.
 * It returns an engine artifact getter plus a map from verifying key to variant for logging.
 */
export function createVerifiedArtifactSource({
  getOnChainVerifyingKey,
  exportVerificationKey,
  cacheDirectory,
  baseUrl = OFFICIAL_ARTIFACT_BASE_URL,
  hashes = ARTIFACT_V2_HASHES,
  fetchBytes = fetchWithRetry,
  log = () => undefined,
}: ArtifactSourceOptions) {
  const verified = new Map<string, Promise<VerifiedArtifacts>>();
  const variantByKey = new WeakMap<object, string>();

  const readCached = async (variant: string, name: string) => {
    if (!cacheDirectory) return undefined;
    return readFile(join(cacheDirectory, variant, name)).then((data) => new Uint8Array(data), () => undefined);
  };
  const writeCached = async (variant: string, name: string, data: Uint8Array) => {
    if (!cacheDirectory) return;
    await mkdir(join(cacheDirectory, variant), { recursive: true });
    await writeFile(join(cacheDirectory, variant, name), data);
  };

  const hashedArtifact = async (variant: string, name: "zkey" | "wasm") => {
    const expected = hashes[variant]?.[name];
    if (!expected) throw new Error(`Railgun publishes no ${name} hash for circuit ${variant}`);
    const cached = await readCached(variant, name);
    if (cached && sha256Hex(cached) === expected) return cached;

    const url = name === "zkey" ? `${baseUrl}/circuits/${variant}/zkey.br` : `${baseUrl}/prover/snarkjs/${variant}.wasm.br`;
    log(`Downloading proof artifact ${url}`);
    const data = new Uint8Array(brotliDecompressSync(await fetchBytes(url)));
    const actual = sha256Hex(data);
    if (actual !== expected) {
      throw new Error(`Circuit ${variant} ${name} SHA-256 ${actual} does not match Railgun's published ${expected}`);
    }
    await writeCached(variant, name, data);
    return data;
  };

  const officialVerifyingKey = async (variant: string): Promise<SnarkJsVerifyingKey> => {
    // vkey.json has no published hash; it is trusted only after matching the zkey and the pool below.
    const data = (await readCached(variant, "vkey.json")) ?? (await fetchBytes(`${baseUrl}/circuits/${variant}/vkey.json`));
    await writeCached(variant, "vkey.json", data);
    return JSON.parse(new TextDecoder().decode(data)) as SnarkJsVerifyingKey;
  };

  const verify = async (nullifiers: number, commitments: number): Promise<VerifiedArtifacts> => {
    const variant = artifactVariant(nullifiers, commitments);
    const [zkey, wasm, vkey] = await Promise.all([
      hashedArtifact(variant, "zkey"),
      hashedArtifact(variant, "wasm"),
      officialVerifyingKey(variant),
    ]);
    const zkeyDifferences = verifyingKeyDifferences(await exportVerificationKey(zkey), vkey);
    if (zkeyDifferences.length > 0) {
      throw new Error(`Circuit ${variant} zkey verifying key differs from vkey.json: ${zkeyDifferences.join(", ")}`);
    }
    const onChain = await getOnChainVerifyingKey(nullifiers, commitments);
    if (onChain.ic.length === 0) throw new Error(`The pool has no verifying key for circuit ${variant}`);
    const poolDifferences = onChainKeyDifferences(onChain, vkey);
    if (poolDifferences.length > 0) {
      throw new Error(`Circuit ${variant} vkey.json differs from the pool's verifying key: ${poolDifferences.join(", ")}`);
    }
    log(`Circuit ${variant}: zkey and wasm match Railgun's hashes; zkey key == vkey.json == pool key`);
    variantByKey.set(vkey, variant);
    return { zkey, wasm, vkey };
  };

  const verifiedArtifacts = (nullifiers: number, commitments: number) => {
    const variant = artifactVariant(nullifiers, commitments);
    let pending = verified.get(variant);
    if (!pending) {
      pending = verify(nullifiers, commitments);
      pending.catch(() => verified.delete(variant));
      verified.set(variant, pending);
    }
    return pending;
  };

  const getter = {
    assertArtifactExists: (nullifiers: number, commitments: number) => {
      if (!hashes[artifactVariant(nullifiers, commitments)]) {
        throw new Error(`Railgun has no official circuit ${artifactVariant(nullifiers, commitments)}`);
      }
    },
    getArtifacts: async (publicInputs: { nullifiers: unknown[]; commitmentsOut: unknown[] }) => {
      const artifacts = await verifiedArtifacts(publicInputs.nullifiers.length, publicInputs.commitmentsOut.length);
      return { zkey: artifacts.zkey, wasm: artifacts.wasm, dat: undefined, vkey: artifacts.vkey };
    },
    getArtifactsPOI: async () => {
      throw new Error("POI proofs are not used by the recover command");
    },
  } as unknown as ArtifactGetter;

  return { getter, verifiedArtifacts, variantOf: (vkey: object) => variantByKey.get(vkey) };
}
