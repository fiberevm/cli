import { describe, expect, it } from "bun:test";
import { loadSnarkJs } from "../src/prover.ts";

describe("snarkjs loading", () => {
  it("leaves a single-threaded BN128 curve where snarkjs looks for it", async () => {
    await loadSnarkJs();
    const curve = (globalThis as { curve_bn128?: { tm?: { singleThread?: boolean } } }).curve_bn128;
    // A missing curve makes snarkjs start ffjavascript workers, which can hang under Bun.
    expect(curve?.tm?.singleThread).toBe(true);
  });
});
