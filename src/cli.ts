import { open } from "node:fs/promises";
import { stderr, stdout } from "node:process";
import packageJson from "../package.json" with { type: "json" };
import { getHelpText, parseCliArguments, type PrivateKeyCommand } from "./arguments.ts";
import { readHiddenPassword, readPasswordFromStdin } from "./password.ts";
import type { PrivateAssetScan } from "./private-assets.ts";
import { deriveKey, type DerivedKey } from "./private-key.ts";
import type { RecoverInput, RecoverOutcome } from "./recover.ts";
import { readWalletSeed } from "./wallet-file.ts";

type Output = Pick<NodeJS.WriteStream, "write">;

export type CliDependencies = {
  readPassword: (fromStdin: boolean) => Promise<string>;
  readSeed: (file: string, password: string) => Promise<Uint8Array>;
  scanPrivateAssets: (input: {
    seed: Uint8Array;
    rpcUrl: string;
    chunkSize?: number;
    onProgress: (message: string) => void;
  }) => Promise<PrivateAssetScan>;
  writeSecretFile: (file: string, contents: string) => Promise<void>;
  /** Defaults to the real recover command; tests inject a stub. */
  recover?: (input: RecoverInput) => Promise<RecoverOutcome>;
  /** Defaults to the terminal CONFIRM prompt. */
  confirm?: () => Promise<boolean>;
  stdout: Output;
  stderr: Output;
};

const defaultDependencies: Required<CliDependencies> = {
  readPassword: (fromStdin) => (fromStdin ? readPasswordFromStdin() : readHiddenPassword()),
  readSeed: readWalletSeed,
  scanPrivateAssets: async (input) => {
    // Keep the heavyweight Railgun engine out of the private-key startup path.
    const { listPrivateAssets } = await import("./private-assets.ts");
    return listPrivateAssets(input);
  },
  writeSecretFile,
  recover: async (input) => {
    // Like the scan, the prover and signing code load only when recover runs.
    const { runRecovery } = await import("./recover.ts");
    return runRecovery(input);
  },
  confirm: async () => {
    const { askForConfirmation } = await import("./transaction-guards.ts");
    return askForConfirmation();
  },
  stdout,
  stderr,
};

/**
 * Creates a new owner-only file for recovered keys and refuses to replace an existing one.
 * It accepts the destination path and the complete secret contents.
 */
export async function writeSecretFile(file: string, contents: string): Promise<void> {
  let handle;
  try {
    handle = await open(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`--output file already exists: ${file}`);
    }
    throw error;
  }
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
}

/**
 * Renders recovered keys in the selected format.
 * One text key stays a bare line for backward-compatible piping; a range becomes a table.
 */
export function formatKeys(keys: DerivedKey[], json: boolean): string {
  if (json) return `${JSON.stringify(keys, null, 2)}\n`;
  if (keys.length === 1) return `${keys[0]!.privateKey}\n`;

  const rows = keys.map((key) =>
    `${key.derivationIndex}\t${key.derivationPath}\t${key.address}\t${key.privateKey}`
  );
  return `INDEX\tPATH\tADDRESS\tPRIVATE_KEY\n${rows.join("\n")}\n`;
}

/** Prints recovered keys to stdout or a new file, with addresses on stderr for verification. */
async function writePrivateKeys(
  keys: DerivedKey[],
  parsed: PrivateKeyCommand,
  dependencies: CliDependencies,
): Promise<void> {
  const chain = parsed.chain.toUpperCase();
  const noun = keys.length === 1 ? "private key" : "private keys";
  const contents = formatKeys(keys, parsed.json);

  // Addresses are not secret, so stderr lists them whenever stdout would not show them.
  const writeAddresses = () => {
    for (const key of keys) {
      dependencies.stderr.write(`Address: ${key.address} (${key.derivationPath})\n`);
    }
  };

  if (parsed.output !== undefined) {
    await dependencies.writeSecretFile(parsed.output, contents);
    dependencies.stderr.write(
      `Wrote ${keys.length} live ${chain} ${noun} to ${parsed.output} (mode 0600). Keep it secret.\n`,
    );
    writeAddresses();
    return;
  }

  if (keys.length === 1 && !parsed.json) {
    writeAddresses();
    dependencies.stderr.write(`WARNING: the next line is a live ${chain} private key. Keep it secret.\n`);
  } else {
    dependencies.stderr.write(
      `WARNING: the output below contains ${keys.length} live ${chain} ${noun}. Keep it secret.\n`,
    );
  }
  dependencies.stdout.write(contents);
}

/**
 * Writes an exhaustive private-asset scan in human-readable or stable JSON form.
 * It accepts the scan result, output mode, and the destination stream.
 */
export function writePrivateAssets(scan: PrivateAssetScan, json: boolean, output: Output): void {
  if (json) {
    output.write(`${JSON.stringify(scan, null, 2)}\n`);
    return;
  }

  output.write(`Network: ${scan.network} (${scan.chainId})\n`);
  if (scan.assets.length === 0) {
    output.write("No private assets found.\n");
    return;
  }

  output.write("TYPE\tADDRESS\tTOKEN_ID\tRAW_AMOUNT\n");
  for (const asset of scan.assets) {
    output.write(`${asset.type}\t${asset.address}\t${asset.tokenId ?? "-"}\t${asset.rawAmount}\n`);
  }
}

/**
 * Runs one Fiber recovery command with injectable I/O for deterministic security tests.
 * It accepts raw CLI arguments and returns the process exit code instead of exiting itself.
 */
export async function runCli(
  args: string[],
  dependencies: CliDependencies = defaultDependencies,
): Promise<number> {
  try {
    const parsed = parseCliArguments(args);
    if (parsed.command === "help") {
      dependencies.stdout.write(getHelpText(parsed.topic));
      return 0;
    }
    if (parsed.command === "version") {
      dependencies.stdout.write(`${packageJson.version}\n`);
      return 0;
    }

    const password = await dependencies.readPassword(parsed.passwordStdin);
    const seed = await dependencies.readSeed(parsed.file, password);

    try {
      if (parsed.command === "private-key") {
        const keys: DerivedKey[] = [];
        for (const derivationIndex of parsed.derivationIndexes) {
          keys.push(await deriveKey(seed, parsed.chain, derivationIndex));
        }
        await writePrivateKeys(keys, parsed, dependencies);
        return 0;
      }

      if (parsed.command === "recover") {
        const recover = dependencies.recover ?? defaultDependencies.recover;
        const outcome = await recover({
          seed,
          rpcUrl: parsed.rpcUrl,
          chunkSize: parsed.chunkSize,
          token: parsed.token,
          amount: parsed.amount,
          derivationIndex: parsed.derivationIndex,
          redeemTo: parsed.redeemTo,
          artifactsDirectory: parsed.artifactsDirectory,
          dryRun: parsed.dryRun,
          confirm: dependencies.confirm ?? defaultDependencies.confirm,
          onProgress: (message) => dependencies.stderr.write(`${message}\n`),
          output: (line) => dependencies.stdout.write(`${line}\n`),
        });
        // A cancelled confirmation is not a successful recovery.
        return outcome === "cancelled" ? 1 : 0;
      }

      const scan = await dependencies.scanPrivateAssets({
        seed,
        rpcUrl: parsed.rpcUrl,
        chunkSize: parsed.chunkSize,
        onProgress: (message) => dependencies.stderr.write(`${message}\n`),
      });
      writePrivateAssets(scan, parsed.json, dependencies.stdout);
      return 0;
    } finally {
      seed.fill(0);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown failure";
    dependencies.stderr.write(`Error: ${message}\n`);
    return 1;
  }
}
