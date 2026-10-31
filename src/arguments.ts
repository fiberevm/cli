import { getAddress } from "ethers/address";
import type { FiberKeyNetwork } from "./chains.ts";

export type PrivateKeyCommand = {
  command: "private-key";
  file: string;
  derivationIndexes: number[];
  chain: FiberKeyNetwork;
  passwordStdin: boolean;
  json: boolean;
  output?: string;
};

export type PrivateAssetsCommand = {
  command: "private-assets";
  file: string;
  rpcUrl: string;
  /** Largest eth_getLogs block span; omitted, the scan learns the RPC's limit. */
  chunkSize?: number;
  passwordStdin: boolean;
  json: boolean;
};

export type RecoverCommand = {
  command: "recover";
  file: string;
  rpcUrl: string;
  chunkSize?: number;
  /** ERC-20 to unshield from the private balance. */
  token: string;
  /** Raw amount; undefined unshields the whole spendable balance. */
  amount?: bigint;
  /** EVM account that receives the unshield, signs, and pays gas. Always explicit. */
  derivationIndex: number;
  /** When set, --token is an ERC-4626 vault and its shares are redeemed to this address. */
  redeemTo?: string;
  artifactsDirectory?: string;
  dryRun: boolean;
  /** Always false: the confirmation prompt needs the terminal's stdin. */
  passwordStdin: false;
};

export type HelpTopic = "private-key" | "private-assets" | "recover";

export type CliCommand =
  | PrivateKeyCommand
  | PrivateAssetsCommand
  | RecoverCommand
  | { command: "help"; topic?: HelpTopic }
  | { command: "version" };

/** Caps one range so a typo cannot print thousands of live keys. */
export const MAX_DERIVATION_RANGE = 100;
const MAX_DERIVATION_INDEX = 2 ** 31 - 1;
export const MAX_CHUNK_SIZE = 1_000_000;

const BOOLEAN_FLAGS = new Set(["--password-stdin", "--json", "--dry-run"]);

export const HELP_TEXT = `Fiber wallet recovery CLI

Usage:
  fiber private-key --file <backup.fiberseed> [--chain <evm|solana>] [--derivation-index <index|start-end>]
                    [--json] [--output <file>] [--password-stdin]
  fiber private-assets --file <backup.fiberseed> --rpc-url <url> [--chunk <blocks>] [--json] [--password-stdin]
  fiber recover --file <backup.fiberseed> --rpc-url <url> --token <address> --derivation-index <index>
                [--amount <raw>] [--redeem-to <address>] [--artifacts-dir <dir>] [--chunk <blocks>] [--dry-run]
  fiber help [private-key|private-assets|recover]
  fiber --version

Security:
  Every file operation requires a password through a hidden prompt or stdin.
  Passwords are never accepted as a command-line value.
  private-assets and recover have no default RPC URL and never read one from the environment.
  recover SIGNS AND SENDS TRANSACTIONS, and only after you type CONFIRM.

Run "fiber <command> --help" for command details.
`;

export const PRIVATE_KEY_HELP_TEXT = `Usage:
  fiber private-key --file <backup.fiberseed> [options]

Derives Fiber private keys from a password-encrypted .fiberseed export. No network access is used.

Options:
  --file <path>                 The .fiberseed export to decrypt. Required.
  --chain <evm|solana>          Key type to derive. Defaults to evm.
  --derivation-index <n|a-b>    One account index, or an inclusive range of up to ${MAX_DERIVATION_RANGE}. Defaults to 0.
  --json                        Print a JSON array of {chain, derivationIndex, derivationPath, address, privateKey}.
  --output <file>               Write the keys to a new file with mode 0600 instead of standard output.
                                Refuses to overwrite an existing file.
  --password-stdin              Read the export password from the first line of stdin.

Derivation paths:
  evm      m/44'/60'/0'/0/<index>    Shared by every Fiber EVM network.
  solana   m/44'/501'/<index>'/0'    Phantom-compatible.

Output:
  One index prints only the private key on standard output; its address and path go to standard error.
  A range prints a tab-separated table: INDEX, PATH, ADDRESS, PRIVATE_KEY.
  EVM keys are 0x-prefixed 32-byte hex. Solana keys are base58 64-byte secret keys.
`;

export const PRIVATE_ASSETS_HELP_TEXT = `Usage:
  fiber private-assets --file <backup.fiberseed> --rpc-url <url> [options]

Scans the selected RPC's chain for spendable private ERC-20, ERC-721, and ERC-1155 assets.

Options:
  --file <path>         The .fiberseed export to decrypt. Required.
  --rpc-url <url>       http or https RPC for the chain to scan. Required; there is no default.
  --chunk <blocks>      Largest eth_getLogs block range per request, from 1 through ${MAX_CHUNK_SIZE}
                        (for example 100 on free RPCs). Without it, the scan halves the range
                        whenever the RPC rejects it.
  --json                Print the scan result as JSON.
  --password-stdin      Read the export password from the first line of stdin.
`;

export const RECOVER_HELP_TEXT = `Usage:
  fiber recover --file <backup.fiberseed> --rpc-url <url> --token <address> --derivation-index <index> [options]

SIGNS AND SENDS TRANSACTIONS. Unshields --token from the private balance to the EVM account at
--derivation-index, which signs and pays gas. With --redeem-to, --token must be an ERC-4626 vault:
after the unshield confirms, its shares are redeemed and the underlying asset goes to --redeem-to.

Before anything is signed it verifies Railgun's proof artifacts against Railgun's published hashes
and the pool's on-chain verifying keys, verifies the proof locally, simulates every step with
eth_simulateV1, prints the plan, and waits until you type CONFIRM. Available on Base.

Options:
  --file <path>              The .fiberseed export to decrypt. Required.
  --rpc-url <url>            http or https RPC that supports eth_simulateV1. Required; there is no default.
  --token <address>          ERC-20 (or ERC-4626 vault share) to unshield. Required.
  --derivation-index <n>     EVM account that receives the unshield, signs, and pays gas. Required.
                             Fiber's own accounts start at index 1; see "fiber private-key --help".
                             Prefer an index Fiber is not actively using (see below).
  --amount <raw>             Raw integer amount. Defaults to the whole spendable balance.
  --redeem-to <address>      Redeem the unshielded vault shares and send the underlying asset here.
  --artifacts-dir <dir>      Keep verified proof artifacts between runs; they are re-verified each time.
  --chunk <blocks>           Largest eth_getLogs block range per request, as for private-assets.
  --dry-run                  Stop after printing the plan. Nothing is signed or sent.

Choosing the account:
  Fiber's backend can treat tokens that arrive at one of its deposit or routing addresses as a new
  deposit and move them back into the vault or the private balance, possibly before the redeem.
  Use an index Fiber is not actively using. recover sends the redeem right after the unshield's first
  confirmation to keep that window short. If the tokens are re-deposited anyway, nothing is lost:
  they show up again in private-assets, and you can run recover again.

The password must come from the hidden prompt, because the confirmation also reads the terminal.
`;

/** Returns the help text for the general usage or one command. */
export function getHelpText(topic?: HelpTopic): string {
  if (topic === "private-key") return PRIVATE_KEY_HELP_TEXT;
  if (topic === "private-assets") return PRIVATE_ASSETS_HELP_TEXT;
  if (topic === "recover") return RECOVER_HELP_TEXT;
  return HELP_TEXT;
}

function isHelpFlag(argument: string): boolean {
  return argument === "--help" || argument === "-h";
}

function isCommand(argument: string | undefined): argument is HelpTopic {
  return argument === "private-key" || argument === "private-assets" || argument === "recover";
}

function parseAddress(flag: string, value: string): string {
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${flag} must be an EVM address with a valid checksum`);
  }
}

/** Parses one index or an inclusive start-end range into the account indexes to derive. */
function parseDerivationIndexes(value: string): number[] {
  const match = /^(\d+)(?:-(\d+))?$/.exec(value);
  const start = match ? Number(match[1]) : Number.NaN;
  const end = match?.[2] === undefined ? start : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start > MAX_DERIVATION_INDEX ||
    end > MAX_DERIVATION_INDEX
  ) {
    throw new Error(
      "--derivation-index must be an integer from 0 through 2147483647, or a range such as 0-4",
    );
  }
  if (end < start) {
    throw new Error("--derivation-index range must not end before it starts");
  }
  if (end - start + 1 > MAX_DERIVATION_RANGE) {
    throw new Error(`--derivation-index range can include at most ${MAX_DERIVATION_RANGE} indexes`);
  }
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
}

/**
 * Parses the small recovery command surface and rejects ambiguous or unsafe flags.
 * It accepts only the CLI arguments after the executable name.
 */
export function parseCliArguments(args: string[]): CliCommand {
  const command = args[0];
  if (!command || isHelpFlag(command)) {
    return { command: "help" };
  }
  if (command === "help") {
    const topic = args[1];
    if (topic === undefined) return { command: "help" };
    if (!isCommand(topic)) throw new Error(`Unknown command: ${topic}`);
    return { command: "help", topic };
  }
  if (command === "--version" || command === "-v" || command === "version") {
    return { command: "version" };
  }
  if (!isCommand(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  // Help wins over validation so a half-typed command can still show its usage.
  if (args.slice(1).some(isHelpFlag)) {
    return { command: "help", topic: command };
  }

  let file: string | undefined;
  let rpcUrl: string | undefined;
  let output: string | undefined;
  let chunkSize: number | undefined;
  let derivationIndexes = [0];
  let derivationIndexWasSet = false;
  let chain: FiberKeyNetwork = "evm";
  let chainWasSet = false;
  let passwordStdin = false;
  let json = false;
  let dryRun = false;
  let tokenAddress: string | undefined;
  let amount: bigint | undefined;
  let redeemTo: string | undefined;
  let artifactsDirectory: string | undefined;

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    const separator = argument.startsWith("--") ? argument.indexOf("=") : -1;
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);

    if (flag === "--password") {
      throw new Error("Do not pass passwords as arguments; use the hidden prompt or --password-stdin");
    }
    if (BOOLEAN_FLAGS.has(flag)) {
      if (inlineValue !== undefined) throw new Error(`${flag} does not take a value`);
      if (flag === "--password-stdin") passwordStdin = true;
      else if (flag === "--dry-run") dryRun = true;
      else json = true;
      continue;
    }

    let value = inlineValue;
    if (value === undefined) {
      value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
      }
      index += 1;
    } else if (!value) {
      throw new Error(`${flag} requires a value`);
    }

    if (flag === "--file") {
      file = value;
    } else if (flag === "--chain") {
      if (value !== "evm" && value !== "solana") {
        throw new Error("--chain must be evm or solana");
      }
      chain = value;
      chainWasSet = true;
    } else if (flag === "--rpc-url") {
      rpcUrl = value;
    } else if (flag === "--derivation-index") {
      derivationIndexes = parseDerivationIndexes(value);
      derivationIndexWasSet = true;
    } else if (flag === "--output") {
      output = value;
    } else if (flag === "--chunk") {
      chunkSize = /^\d+$/.test(value) ? Number(value) : Number.NaN;
      if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK_SIZE) {
        throw new Error(`--chunk must be an integer from 1 through ${MAX_CHUNK_SIZE}`);
      }
    } else if (flag === "--token") {
      tokenAddress = parseAddress(flag, value);
    } else if (flag === "--amount") {
      if (!/^\d+$/.test(value) || BigInt(value) === 0n) {
        throw new Error("--amount must be a positive integer in the token's smallest unit");
      }
      amount = BigInt(value);
    } else if (flag === "--redeem-to") {
      redeemTo = parseAddress(flag, value);
    } else if (flag === "--artifacts-dir") {
      artifactsDirectory = value;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  if (!file) {
    throw new Error("--file is required");
  }
  if (command !== "recover") {
    for (const [flag, used] of [
      ["--token", tokenAddress !== undefined],
      ["--amount", amount !== undefined],
      ["--redeem-to", redeemTo !== undefined],
      ["--artifacts-dir", artifactsDirectory !== undefined],
      ["--dry-run", dryRun],
    ] as const) {
      if (used) throw new Error(`${flag} is only valid for recover`);
    }
  }

  if (command === "private-key") {
    if (rpcUrl) throw new Error("--rpc-url is only valid for private-assets and recover");
    if (chunkSize !== undefined) throw new Error("--chunk is only valid for private-assets and recover");
    return {
      command,
      file,
      derivationIndexes,
      chain,
      passwordStdin,
      json,
      ...(output === undefined ? {} : { output }),
    };
  }

  if (!rpcUrl) {
    throw new Error(`--rpc-url is required for ${command}; there is no default RPC URL`);
  }
  try {
    const parsedRpcUrl = new URL(rpcUrl);
    if (parsedRpcUrl.protocol !== "https:" && parsedRpcUrl.protocol !== "http:") throw new Error();
  } catch {
    throw new Error("--rpc-url must be a valid http or https URL");
  }
  if (chainWasSet) {
    throw new Error("--chain is only valid for private-key");
  }
  if (output !== undefined) {
    throw new Error("--output is only valid for private-key");
  }

  if (command === "recover") {
    if (!tokenAddress) throw new Error("--token is required for recover");
    // Fiber never uses index 0, so a default would silently pick an account that holds nothing.
    if (!derivationIndexWasSet) {
      throw new Error(
        "--derivation-index is required for recover; Fiber's accounts start at 1 (find yours with private-key --derivation-index 1-20)",
      );
    }
    if (derivationIndexes.length !== 1) throw new Error("--derivation-index must be a single index for recover");
    if (json) throw new Error("--json is only valid for private-key and private-assets");
    // The confirmation prompt reads the terminal, so the password cannot come from stdin.
    if (passwordStdin) throw new Error("recover asks for confirmation on the terminal; use the hidden password prompt");
    if (redeemTo?.toLowerCase() === tokenAddress.toLowerCase()) throw new Error("--redeem-to cannot be the vault itself");
    return {
      command,
      file,
      rpcUrl,
      ...(chunkSize === undefined ? {} : { chunkSize }),
      token: tokenAddress,
      ...(amount === undefined ? {} : { amount }),
      derivationIndex: derivationIndexes[0]!,
      ...(redeemTo === undefined ? {} : { redeemTo }),
      ...(artifactsDirectory === undefined ? {} : { artifactsDirectory }),
      dryRun,
      passwordStdin: false,
    };
  }

  if (derivationIndexWasSet) {
    throw new Error("--derivation-index is only valid for private-key and recover");
  }
  return {
    command,
    file,
    rpcUrl,
    ...(chunkSize === undefined ? {} : { chunkSize }),
    passwordStdin,
    json,
  };
}
