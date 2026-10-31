// Minimal types for the parts of snarkjs and ffjavascript that the recover command uses.

declare module "snarkjs" {
  export const groth16: {
    fullProve(input: unknown, wasm: Uint8Array, zkey: Uint8Array): Promise<{ proof: unknown; publicSignals: unknown[] }>;
    verify(verifyingKey: object, publicSignals: unknown[], proof: unknown): Promise<boolean>;
  };
  export const zKey: {
    exportVerificationKey(zkey: Uint8Array): Promise<Record<string, unknown>>;
  };
}

declare module "ffjavascript" {
  export function buildBn128(singleThread?: boolean): Promise<{ terminate(): Promise<void> }>;
}
