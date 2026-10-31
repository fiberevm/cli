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

export type HelpTopic = "private-key" | "private-assets";

export type CliCommand =
  | PrivateKeyCommand
  | PrivateAssetsCommand
  | { command: "help"; topic?: HelpTopic }
  | { command: "version" };

/** Caps one range so a typo cannot print thousands of live keys. */
export const MAX_DERIVATION_RANGE = 100;
const MAX_DERIVATION_INDEX = 2 ** 31 - 1;
export const MAX_CHUNK_SIZE = 1_000_000;

const BOOLEAN_FLAGS = new Set(["--password-stdin", "--json"]);

export const HELP_TEXT = `Fiber wallet recovery CLI

Usage:
  fiber private-key --file <backup.fiberseed> [--chain <evm|solana>] [--derivation-index <index|start-end>]
                    [--json] [--output <file>] [--password-stdin]
  fiber private-assets --file <backup.fiberseed> --rpc-url <url> [--chunk <blocks>] [--json] [--password-stdin]
  fiber help [private-key|private-assets]
  fiber --version

Security:
  Every file operation requires a password through a hidden prompt or stdin.
  Passwords are never accepted as a command-line value.
  private-assets has no default RPC URL and never reads one from the environment.

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

/** Returns the help text for the general usage or one command. */
export function getHelpText(topic?: HelpTopic): string {
  if (topic === "private-key") return PRIVATE_KEY_HELP_TEXT;
  if (topic === "private-assets") return PRIVATE_ASSETS_HELP_TEXT;
  return HELP_TEXT;
}

function isHelpFlag(argument: string): boolean {
  return argument === "--help" || argument === "-h";
}

function isCommand(argument: string | undefined): argument is HelpTopic {
  return argument === "private-key" || argument === "private-assets";
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
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  if (!file) {
    throw new Error("--file is required");
  }

  if (command === "private-key") {
    if (rpcUrl) throw new Error("--rpc-url is only valid for private-assets");
    if (chunkSize !== undefined) throw new Error("--chunk is only valid for private-assets");
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
    throw new Error("--rpc-url is required for private-assets; there is no default RPC URL");
  }
  try {
    const parsedRpcUrl = new URL(rpcUrl);
    if (parsedRpcUrl.protocol !== "https:" && parsedRpcUrl.protocol !== "http:") throw new Error();
  } catch {
    throw new Error("--rpc-url must be a valid http or https URL");
  }
  if (derivationIndexWasSet) {
    throw new Error("--derivation-index is only valid for private-key");
  }
  if (chainWasSet) {
    throw new Error("--chain is only valid for private-key");
  }
  if (output !== undefined) {
    throw new Error("--output is only valid for private-key");
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
