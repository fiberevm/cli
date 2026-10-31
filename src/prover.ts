import type { RailgunEngine } from "@railgun-community/engine";

type SnarkJs = typeof import("snarkjs");
export type ProofCheck = { variant: string; valid: boolean; publicSignals: number };

let snarkJs: Promise<SnarkJs> | undefined;

/**
 * Loads snarkjs once. ffjavascript's multi-threaded BN128 curve can hang under Bun on Windows while
 * waiting for its workers, so a single-threaded curve is built and left where snarkjs looks for it.
 * snarkjs is imported first: loading ffjavascript resets that global, and snarkjs may load its own copy.
 */
export function loadSnarkJs(): Promise<SnarkJs> {
  snarkJs ??= (async () => {
    const loaded = await import("snarkjs");
    const { buildBn128 } = await import("ffjavascript");
    const globals = globalThis as { curve_bn128?: unknown };
    globals.curve_bn128 ??= await buildBn128(true);
    return loaded;
  })();
  return snarkJs;
}

/**
 * Connects snarkjs Groth16 to the engine. The engine verifies every proof it generates against the
 * circuit's verifying key and aborts if it fails; this also reports each local verification.
 */
export async function attachProver(
  engine: RailgunEngine,
  variantOf: (verifyingKey: object) => string | undefined,
  onCheck: (check: ProofCheck) => void,
): Promise<void> {
  const { groth16 } = await loadSnarkJs();
  const prover = {
    fullProve: groth16.fullProve,
    verify: async (verifyingKey: object, publicSignals: unknown[], proof: unknown) => {
      const valid = await groth16.verify(verifyingKey, publicSignals, proof);
      onCheck({ variant: variantOf(verifyingKey) ?? "unknown", valid, publicSignals: publicSignals.length });
      return valid;
    },
  };
  engine.prover.setSnarkJSGroth16(prover as unknown as Parameters<typeof engine.prover.setSnarkJSGroth16>[0]);
}
