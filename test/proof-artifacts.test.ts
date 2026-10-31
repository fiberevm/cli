import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync } from "node:zlib";
import {
  artifactVariant,
  createVerifiedArtifactSource,
  onChainKeyDifferences,
  sha256Hex,
  verifyingKeyDifferences,
  type OnChainVerifyingKey,
  type SnarkJsVerifyingKey,
} from "../src/proof-artifacts.ts";

// Synthetic circuit data: small numbers stand in for curve points; nothing here is a real key.
const officialKey: SnarkJsVerifyingKey = {
  protocol: "groth16",
  curve: "bn128",
  nPublic: 1,
  vk_alpha_1: ["1", "2", "1"],
  vk_beta_2: [["3", "4"], ["5", "6"], ["1", "0"]],
  vk_gamma_2: [["7", "8"], ["9", "10"], ["1", "0"]],
  vk_delta_2: [["11", "12"], ["13", "14"], ["1", "0"]],
  IC: [["15", "16", "1"], ["17", "18", "1"]],
};
// The pool stores G2 coordinates swapped ([x1, x0]), as Railgun's verifier does.
const poolKey: OnChainVerifyingKey = {
  alpha1: { x: 1n, y: 2n },
  beta2: { x: [4n, 3n], y: [6n, 5n] },
  gamma2: { x: [8n, 7n], y: [10n, 9n] },
  delta2: { x: [12n, 11n], y: [14n, 13n] },
  ic: [{ x: 15n, y: 16n }, { x: 17n, y: 18n }],
};
const zkey = new TextEncoder().encode("synthetic zkey bytes");
const wasm = new TextEncoder().encode("synthetic wasm bytes");
const hashes = { "01x02": { zkey: sha256Hex(zkey), wasm: sha256Hex(wasm) } };

function source(overrides: { zkey?: Uint8Array; zkeyKey?: SnarkJsVerifyingKey; poolKey?: OnChainVerifyingKey; cacheDirectory?: string } = {}) {
  const fetched: string[] = [];
  const files: Record<string, Uint8Array> = {
    "/circuits/01x02/zkey.br": brotliCompressSync(overrides.zkey ?? zkey),
    "/prover/snarkjs/01x02.wasm.br": brotliCompressSync(wasm),
    "/circuits/01x02/vkey.json": new TextEncoder().encode(JSON.stringify(officialKey)),
  };
  const artifacts = createVerifiedArtifactSource({
    baseUrl: "https://artifacts.invalid",
    hashes,
    cacheDirectory: overrides.cacheDirectory,
    fetchBytes: async (url) => {
      fetched.push(url);
      const file = files[url.replace("https://artifacts.invalid", "")];
      if (!file) throw new Error(`unexpected URL ${url}`);
      return new Uint8Array(file);
    },
    exportVerificationKey: async () => overrides.zkeyKey ?? officialKey,
    getOnChainVerifyingKey: async () => overrides.poolKey ?? poolKey,
  });
  return { artifacts, fetched };
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("verifying key comparison", () => {
  it("names circuit variants by nullifiers and commitments", () => {
    expect(artifactVariant(1, 2)).toBe("01x02");
    expect(artifactVariant(13, 1)).toBe("13x01");
  });

  it("accepts the pool's key in either G2 coordinate order", () => {
    expect(onChainKeyDifferences(poolKey, officialKey)).toEqual([]);
    const direct = { ...poolKey, beta2: { x: [3n, 4n], y: [5n, 6n] } };
    expect(onChainKeyDifferences(direct, officialKey)).toEqual([]);
  });

  it("reports every on-chain field that differs", () => {
    const tampered = { ...poolKey, alpha1: { x: 1n, y: 99n }, delta2: { x: [11n, 12n], y: [14n, 13n] }, ic: [poolKey.ic[0]!] };
    expect(onChainKeyDifferences(tampered, officialKey)).toEqual(["alpha1", "delta2", "ic length 1 != 2"]);
  });

  it("compares snarkjs keys field by field, ignoring labels", () => {
    expect(verifyingKeyDifferences({ ...officialKey, protocol: "other" }, officialKey)).toEqual([]);
    expect(verifyingKeyDifferences({ ...officialKey, IC: [] }, officialKey)).toEqual(["IC"]);
  });
});

describe("verified artifact source", () => {
  it("returns artifacts that pass the hash, zkey, and pool checks", async () => {
    const { artifacts } = source();

    const result = await artifacts.getter.getArtifacts({ nullifiers: [1], commitmentsOut: [1, 2] } as never);

    expect(Buffer.from(result.zkey as Uint8Array).toString()).toBe("synthetic zkey bytes");
    expect(Buffer.from(result.wasm as Uint8Array).toString()).toBe("synthetic wasm bytes");
    expect(artifacts.variantOf(result.vkey as object)).toBe("01x02");
  });

  it("rejects a zkey whose hash differs from Railgun's published hash", async () => {
    const { artifacts } = source({ zkey: new TextEncoder().encode("tampered zkey") });
    await expect(artifacts.verifiedArtifacts(1, 2)).rejects.toThrow("does not match Railgun's published");
  });

  it("rejects a vkey.json that differs from the key inside the zkey", async () => {
    const { artifacts } = source({ zkeyKey: { ...officialKey, vk_alpha_1: ["1", "3", "1"] } });
    await expect(artifacts.verifiedArtifacts(1, 2)).rejects.toThrow("zkey verifying key differs from vkey.json: vk_alpha_1");
  });

  it("rejects artifacts whose key differs from the pool's on-chain key", async () => {
    const { artifacts } = source({ poolKey: { ...poolKey, gamma2: { x: [1n, 1n], y: [1n, 1n] } } });
    await expect(artifacts.verifiedArtifacts(1, 2)).rejects.toThrow("differs from the pool's verifying key: gamma2");
  });

  it("refuses a pool without a key for the circuit and unknown circuits", async () => {
    const { artifacts } = source({ poolKey: { ...poolKey, ic: [] } });
    await expect(artifacts.verifiedArtifacts(1, 2)).rejects.toThrow("no verifying key");
    expect(() => (artifacts.getter as unknown as { assertArtifactExists: (n: number, c: number) => void }).assertArtifactExists(9, 9))
      .toThrow("no official circuit 09x09");
  });

  it("reuses a verified cache and re-downloads a tampered cached file", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "fiber-artifacts-"));
    temporaryDirectories.push(cacheDirectory);
    await source({ cacheDirectory }).artifacts.verifiedArtifacts(1, 2);

    const cached = source({ cacheDirectory });
    await cached.artifacts.verifiedArtifacts(1, 2);
    expect(cached.fetched).toEqual([]);

    await writeFile(join(cacheDirectory, "01x02", "zkey"), "tampered cache");
    const repaired = source({ cacheDirectory });
    await repaired.artifacts.verifiedArtifacts(1, 2);
    expect(repaired.fetched).toEqual(["https://artifacts.invalid/circuits/01x02/zkey.br"]);
  });
});
