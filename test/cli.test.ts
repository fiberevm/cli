import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPublicKeyAsync } from "@noble/ed25519";
import { base58 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { computeAddress } from "ethers/transaction";
import packageJson from "../package.json" with { type: "json" };
import { PRIVATE_KEY_HELP_TEXT } from "../src/arguments.ts";
import { runCli, writeSecretFile, type CliDependencies } from "../src/cli.ts";

function outputBuffer() {
  let value = "";
  return {
    stream: { write: (chunk: string | Uint8Array) => ((value += chunk.toString()), true) },
    read: () => value,
  };
}

/** Builds key-recovery dependencies around a fixed seed and captured output streams. */
function keyDependencies(seed: Uint8Array, overrides: Partial<CliDependencies> = {}) {
  const standardOutput = outputBuffer();
  const standardError = outputBuffer();
  const dependencies: CliDependencies = {
    readPassword: async () => "correct horse battery staple",
    readSeed: async () => seed,
    scanPrivateAssets: async () => {
      throw new Error("not used");
    },
    writeSecretFile: async () => {
      throw new Error("not used");
    },
    stdout: standardOutput.stream,
    stderr: standardError.stream,
    ...overrides,
  };
  return { dependencies, stdout: standardOutput.read, stderr: standardError.read };
}

function expectedEvmAccount(seed: Uint8Array, index: number) {
  const privateKey = `0x${Buffer.from(
    HDKey.fromMasterSeed(seed).derive(`m/44'/60'/0'/0/${index}`).privateKey!,
  ).toString("hex")}`;
  return { privateKey, address: computeAddress(privateKey) };
}

const SOLANA_SEED = Uint8Array.from([
  25, 21, 117, 29, 175, 18, 6, 213, 217, 118, 102, 185, 30, 152, 247, 183,
  184, 112, 74, 17, 73, 112, 103, 80, 129, 1, 240, 248, 88, 247, 58, 12,
]);

describe("Fiber CLI commands", () => {
  it("prints the Fiber EVM private key and clears the supplied seed buffer", async () => {
    const seed = new Uint8Array(32).fill(0x42);
    const expected = expectedEvmAccount(seed, 0);
    const { dependencies, stdout, stderr } = keyDependencies(seed, {
      readSeed: async (_file, password) => {
        expect(password).toBe("correct horse battery staple");
        return seed;
      },
    });
    const exitCode = await runCli(["private-key", "--file", "backup.fiberseed"], dependencies);

    expect(exitCode).toBe(0);
    expect(stdout()).toBe(`${expected.privateKey}\n`);
    expect(stderr()).toContain("live EVM private key");
    expect(seed.every((byte) => byte === 0)).toBe(true);
  });

  it("shows the address a single key controls on stderr, not stdout", async () => {
    const seed = new Uint8Array(32).fill(0x42);
    const expected = expectedEvmAccount(seed, 3);
    const { dependencies, stdout, stderr } = keyDependencies(seed);
    const exitCode = await runCli(
      ["private-key", "--file", "backup.fiberseed", "--derivation-index", "3"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(stdout()).toBe(`${expected.privateKey}\n`);
    expect(stderr()).toContain(`Address: ${expected.address} (m/44'/60'/0'/0/3)`);
  });

  it("prints the Phantom-compatible Solana private key and address used by Fiber", async () => {
    const seed = SOLANA_SEED.slice();
    const expectedPrivateSeed = "280868d081035690222240d6f975c357a65dec75fd060aeae4762477f2e9cef2";
    const expectedAddress = base58.encode(
      await getPublicKeyAsync(Buffer.from(expectedPrivateSeed, "hex")),
    );
    const { dependencies, stdout, stderr } = keyDependencies(seed);
    const exitCode = await runCli(
      ["private-key", "--file", "backup.fiberseed", "--chain", "solana"],
      dependencies,
    );
    const decodedSecretKey = base58.decode(stdout().trim());

    expect(exitCode).toBe(0);
    expect(Buffer.from(decodedSecretKey.slice(0, 32)).toString("hex")).toBe(expectedPrivateSeed);
    expect(base58.encode(decodedSecretKey.slice(32))).toBe(expectedAddress);
    expect(decodedSecretKey).toHaveLength(64);
    expect(stderr()).toContain(`Address: ${expectedAddress} (m/44'/501'/0'/0')`);
    expect(stderr()).toContain("SOLANA private key");
    expect(seed.every((byte) => byte === 0)).toBe(true);
    decodedSecretKey.fill(0);
  });

  it("prints a derivation range as a table after one password prompt", async () => {
    const seed = new Uint8Array(32).fill(0x42);
    const expectedRows = [2, 3, 4].map((index) => {
      const account = expectedEvmAccount(seed, index);
      return `${index}\tm/44'/60'/0'/0/${index}\t${account.address}\t${account.privateKey}`;
    });
    let passwordPrompts = 0;
    const { dependencies, stdout, stderr } = keyDependencies(seed, {
      readPassword: async () => {
        passwordPrompts += 1;
        return "correct horse battery staple";
      },
    });
    const exitCode = await runCli(
      ["private-key", "--file", "backup.fiberseed", "--derivation-index", "2-4"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(passwordPrompts).toBe(1);
    expect(stdout()).toBe(`INDEX\tPATH\tADDRESS\tPRIVATE_KEY\n${expectedRows.join("\n")}\n`);
    expect(stderr()).toContain("3 live EVM private keys");
  });

  it("prints keys as JSON for scripts", async () => {
    const seed = new Uint8Array(32).fill(0x42);
    const { dependencies, stdout } = keyDependencies(seed);
    const exitCode = await runCli(
      ["private-key", "--file=backup.fiberseed", "--derivation-index=0-1", "--json"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout())).toEqual(
      [0, 1].map((index) => ({
        chain: "evm",
        derivationIndex: index,
        derivationPath: `m/44'/60'/0'/0/${index}`,
        ...expectedEvmAccount(new Uint8Array(32).fill(0x42), index),
      })),
    );
  });

  it("writes keys to the output file and keeps them off stdout", async () => {
    const seed = new Uint8Array(32).fill(0x42);
    const expected = expectedEvmAccount(seed, 0);
    const written: { file: string; contents: string }[] = [];
    const { dependencies, stdout, stderr } = keyDependencies(seed, {
      writeSecretFile: async (file, contents) => {
        written.push({ file, contents });
      },
    });
    const exitCode = await runCli(
      ["private-key", "--file", "backup.fiberseed", "--output", "keys.txt"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(written).toEqual([{ file: "keys.txt", contents: `${expected.privateKey}\n` }]);
    expect(stdout()).toBe("");
    expect(stderr()).toContain("Wrote 1 live EVM private key to keys.txt");
    expect(stderr()).toContain(`Address: ${expected.address}`);
    expect(stderr()).not.toContain(expected.privateKey);
  });

  it("prints the package version and per-command help without a password", async () => {
    const { dependencies, stdout } = keyDependencies(new Uint8Array(32), {
      readPassword: async () => {
        throw new Error("must not prompt");
      },
    });

    expect(await runCli(["--version"], dependencies)).toBe(0);
    expect(await runCli(["private-key", "--help"], dependencies)).toBe(0);
    expect(stdout()).toBe(`${packageJson.version}\n${PRIVATE_KEY_HELP_TEXT}`);
  });

  it("passes only the explicit RPC URL into a private asset scan", async () => {
    let receivedRpcUrl: string | undefined;
    const { dependencies, stdout } = keyDependencies(new Uint8Array(32), {
      readPassword: async (fromStdin) => (fromStdin ? "password from stdin" : "wrong path"),
      readSeed: async (_file, password) => {
        expect(password).toBe("password from stdin");
        return new Uint8Array(32).fill(0x11);
      },
      scanPrivateAssets: async ({ rpcUrl }) => {
        receivedRpcUrl = rpcUrl;
        return { chainId: 8453, network: "Base", assets: [] };
      },
    });
    const exitCode = await runCli(
      [
        "private-assets",
        "--file",
        "backup.fiberseed",
        "--rpc-url",
        "https://base.example",
        "--password-stdin",
      ],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(receivedRpcUrl).toBe("https://base.example");
    expect(stdout()).toContain("No private assets found");
  });

  it("passes --chunk into the scan", async () => {
    let receivedChunkSize: number | undefined;
    const { dependencies } = keyDependencies(new Uint8Array(32), {
      readSeed: async () => new Uint8Array(32).fill(0x11),
      scanPrivateAssets: async ({ chunkSize }) => {
        receivedChunkSize = chunkSize;
        return { chainId: 8453, network: "Base", assets: [] };
      },
    });
    const exitCode = await runCli(
      ["private-assets", "--file", "backup.fiberseed", "--rpc-url", "https://base.example", "--chunk", "100"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(receivedChunkSize).toBe(100);
  });

  it("runs recover with the parsed options, then clears the seed", async () => {
    const seed = new Uint8Array(32).fill(0x22);
    let received: Parameters<NonNullable<CliDependencies["recover"]>>[0] | undefined;
    const { dependencies, stdout } = keyDependencies(seed, {
      readPassword: async (fromStdin) => {
        expect(fromStdin).toBe(false);
        return "correct horse battery staple";
      },
      recover: async (input) => {
        received = input;
        input.output("plan line");
        return "completed";
      },
      confirm: async () => true,
    });
    const exitCode = await runCli(
      [
        "recover",
        "--file",
        "backup.fiberseed",
        "--rpc-url",
        "https://base.example",
        "--token",
        "0x00000000000000000000000000000000000000b2",
        "--derivation-index",
        "2",
      ],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(received).toMatchObject({
      rpcUrl: "https://base.example",
      token: "0x00000000000000000000000000000000000000b2",
      derivationIndex: 2,
      dryRun: false,
    });
    expect(stdout()).toBe("plan line\n");
    expect(seed.every((byte) => byte === 0)).toBe(true);
  });

  it("exits 1 when the recover confirmation is cancelled", async () => {
    const { dependencies } = keyDependencies(new Uint8Array(32).fill(0x22), {
      recover: async (input) => ((await input.confirm()) ? "completed" : "cancelled"),
      confirm: async () => false,
    });
    const exitCode = await runCli(
      [
        "recover",
        "--file",
        "backup.fiberseed",
        "--rpc-url",
        "https://base.example",
        "--token",
        "0x00000000000000000000000000000000000000b2",
        "--derivation-index",
        "1",
      ],
      dependencies,
    );

    expect(exitCode).toBe(1);
  });
});

describe("secret output files", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("creates an owner-only file", async () => {
    directory = await mkdtemp(join(tmpdir(), "fiber-cli-"));
    const file = join(directory, "keys.txt");
    await writeSecretFile(file, "secret\n");

    expect(await readFile(file, "utf8")).toBe("secret\n");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("refuses to overwrite an existing file", async () => {
    directory = await mkdtemp(join(tmpdir(), "fiber-cli-"));
    const file = join(directory, "keys.txt");
    await writeFile(file, "keep me\n");

    await expect(writeSecretFile(file, "secret\n")).rejects.toThrow("--output file already exists");
    expect(await readFile(file, "utf8")).toBe("keep me\n");
  });
});
