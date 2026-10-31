# Fiber CLI

> [!WARNING]
> **This CLI is deprecated.** Use [recovery.fiber.so](https://recovery.fiber.so) instead. Its source is at [github.com/fiberevm/recovery](https://github.com/fiberevm/recovery). This repository is no longer maintained, and the instructions below are kept for reference only.

![Fiber mobile and desktop apps — The Stablecoin Neobank](./assets/fiber-stablecoin-neobank.png)

Fiber CLI is a public recovery tool for password-encrypted Fiber `.fiberseed` exports. It can:

- derive and print Fiber EVM or Solana private keys; and
- scan an explicitly selected RPC for spendable private ERC-20, ERC-721, and ERC-1155 assets.

The CLI runs on [Bun](https://bun.sh/) 1.3 or newer. It never uploads the seed or password to Fiber.

## 1. Clone and install

Clone the public source and install its locked dependencies:

```bash
git clone https://github.com/fiberevm/cli.git
cd cli
bun install --frozen-lockfile
bun src/index.ts --help
```

You need the `.fiberseed` file downloaded from the Fiber profile page and the password that protected it.

## 2. Print a private key

Use the hidden password prompt. EVM is the backward-compatible default:

```bash
bun src/index.ts private-key --file ./fiber-wallet-backup-2026-08-31.fiberseed --derivation-index 1
```

EVM keys use the same derivation path as Fiber's enclave, `m/44'/60'/0'/0/<index>`. Fiber gives each deposit and routing address its own index, starting at 1. Fiber never uses index 0, the CLI's default, so pass the index you need. If you don't know it, derive a range and look for your address in the output (see [Several accounts at once](#several-accounts-at-once)).

All Fiber EVM networks use this same key derivation: Ethereum, BNB Smart Chain, Robinhood Chain, Polygon, Base, Arbitrum, Unichain, Monad, Arc, HyperEVM, Plasma, and Sepolia.

For a Phantom-compatible Solana key, add `--chain solana`:

```bash
bun src/index.ts private-key --file ./backup.fiberseed --chain solana --derivation-index 2
```

Solana keys use Fiber's backend path, `m/44'/501'/<index>'/0'`. Fiber numbers its EVM and Solana addresses in one shared sequence, so a Solana address can have any index from 1 up.

EVM output is a `0x`-prefixed 32-byte private key. Solana output is the standard base58 64-byte secret key accepted by wallet importers. The output is a live secret. Do not paste it into chat, logs, tickets, command arguments, or shell history.

For a single key, standard output contains only the key, so existing pipes keep working. The address it controls and its derivation path go to standard error, so you can confirm you have the right account before importing it:

```text
Address: 0x0c6a5255BAd8Cf881B5055e9523d41D8772cB898 (m/44'/60'/0'/0/1)
WARNING: the next line is a live EVM private key. Keep it secret.
0x…
```

### Several accounts at once

Pass an inclusive range to derive up to 100 accounts with one password entry. This is the quickest way to find the index of an address, such as a deposit address you sent funds to:

```bash
bun src/index.ts private-key --file ./backup.fiberseed --derivation-index 1-20
```

A range prints a tab-separated table with the columns `INDEX`, `PATH`, `ADDRESS`, and `PRIVATE_KEY`. To see only the addresses on screen, add `--output <file>` as shown below. The keys go to that file, and the addresses still print.

### JSON and file output

Add `--json` to get an array of `{chain, derivationIndex, derivationPath, address, privateKey}` objects, whether you ask for one key or a range.

Add `--output <file>` to keep keys out of the terminal. The CLI creates a new file with owner-only `0600` permissions and refuses to overwrite one that already exists. Addresses are still printed to standard error so you can check them. Delete the file once you have imported the keys.

```bash
bun src/index.ts private-key \
  --file ./backup.fiberseed \
  --derivation-index 1-20 \
  --json \
  --output ./recovered-keys.json
```

Options also accept the `--flag=value` form. Run `bun src/index.ts private-key --help` for the full option list and derivation paths, and `bun src/index.ts --version` to print the CLI version.

For non-interactive use, pipe exactly one password line. `--password-stdin` is safer than putting the password in the process arguments:

```bash
printf '%s\n' "$FIBER_EXPORT_PASSWORD" | bun src/index.ts private-key \
  --file ./backup.fiberseed \
  --password-stdin
```

## 3. List private assets

Pass the RPC URL you want the CLI to use:

```bash
bun src/index.ts private-assets \
  --file ./backup.fiberseed \
  --rpc-url https://your-rpc.example
```

There is intentionally no default RPC URL. The CLI does not read one from an environment variable and does not fall back to a public provider. It detects the chain with `eth_chainId`, verifies that Railgun supports it, then scans from that network's deployment block through the supplied RPC only. A first scan can take time. The result is only as trustworthy as the RPC, so use a provider you trust.

The RPC must answer `eth_getLogs` for 5,000-block ranges all the way back to the pool's deployment block. Many free public RPCs refuse these historical queries. If the RPC can't serve the full history, the scan stops with an error rather than showing incomplete balances.

Run the command once with the RPC for each chain you need to inspect. Fiber's own private pools are on Ethereum, BNB Smart Chain, Base, Arbitrum, and Sepolia, and the CLI scans each one from the block where Fiber deployed it. On Polygon it scans Railgun's own pool, which the same seed can also hold assets in. The other networks have no private pool to scan. Recover funds there with `private-key`.

| Backend chain | Chain ID | Private-key recovery | Private-asset scan |
| --- | ---: | --- | --- |
| Ethereum | 1 | EVM | Fiber's pool |
| BNB Smart Chain | 56 | EVM | Fiber's pool |
| Robinhood Chain | 4663 | EVM | No private pool |
| Polygon | 137 | EVM | Railgun's pool |
| Base | 8453 | EVM | Fiber's pool |
| Arbitrum | 42161 | EVM | Fiber's pool |
| Unichain | 130 | EVM | No private pool |
| Monad | 143 | EVM | No private pool |
| Arc | 5042 | EVM | No private pool |
| HyperEVM | 999 | EVM | No private pool |
| Plasma | 9745 | EVM | No private pool |
| Sepolia | 11155111 | EVM | Fiber's pool |
| Solana | 101 | Solana | No private pool |

The text output includes the token type, contract address, NFT token ID when applicable, and raw integer amount. Raw ERC-20 amounts are not adjusted for decimals.

Use JSON for scripts:

```bash
bun src/index.ts private-assets \
  --file ./backup.fiberseed \
  --rpc-url https://your-rpc.example \
  --json
```

## File format compatibility

Every `.fiberseed` file has a top-level `format` and numeric `version`. The current format is `fiber-wallet-export` version `1`. The encrypted, authenticated seed payload is versioned too, so changing its layout cannot silently reinterpret seed material.

The CLI currently decodes version 1 and rejects unknown versions before password-based decryption. Future format releases must keep the version 1 decoder so existing backups remain recoverable; new layouts or cryptographic parameters must use a new version instead of changing version 1 in place.

## Password handling

Every `.fiberseed` file requires a password. There is no passwordless file mode or CLI bypass. The default prompt disables terminal echo, and the CLI deliberately rejects `--password <value>` because command arguments are visible in shell history and process listings. Use the hidden prompt or `--password-stdin`; both modes still require a non-empty password. Decrypted scan state stays in memory and is not written to a recovery database on disk.

If the RPC URL contains a provider API key, avoid sharing command output that includes your shell history. Prefer a dedicated, rate-limited RPC credential for recovery.

## Security guidance

For private-key recovery, verify that you cloned `https://github.com/fiberevm/cli` and consider running the command on an offline machine. Review the source before entering a real backup password. The `private-key` command does not need an RPC or any other network service.

The `private-assets` command must contact only the RPC URL you provide. The RPC can observe your IP address and scan requests, so use a provider you trust. The seed and password are decrypted locally and are not sent to the RPC.

Treat the terminal output as a live signing key. Clear terminal scrollback after recovery, and never include the key, seed file, password, or unredacted output in screenshots, logs, support requests, or issue reports.

## Run from source

From the public repository:

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
bun src/index.ts --help
```

The public repository is generated from an explicit file allowlist in Fiber's internal monorepo. Its CI tests the same TypeScript source used by the command, and `private: true` prevents accidental npm publication.
