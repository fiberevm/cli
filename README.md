# Fiber CLI

![Fiber mobile and desktop apps — The Stablecoin Neobank](./assets/fiber-stablecoin-neobank.png)

Fiber CLI is a public recovery tool for password-encrypted Fiber `.fiberseed` exports. It can:

- derive and print Fiber EVM or Solana private keys;
- scan an explicitly selected RPC for spendable private ERC-20, ERC-721, and ERC-1155 assets; and
- on Base, recover a private ERC-20 by unshielding it to one of your accounts, optionally redeeming an ERC-4626 vault share. This command signs transactions and asks for explicit confirmation first.

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

The RPC must answer `eth_getLogs` all the way back to the pool's deployment block. Many free public RPCs refuse these historical queries. If the RPC can't serve the full history, the scan stops with an error rather than showing incomplete balances.

Some free plans do serve the full history but limit each query instead:

- **Block range per query.** Some free plans reject ranges far below the 5,000 blocks the scanner requests at a time, sometimes with an error message that names a larger limit than they actually accept. In testing, a free Base plan accepted only about 100 blocks per query.
- **Rate limits.** Free plans throttle requests per second or per day, and a full scan sends many queries.

The scan handles both. Without options, it starts with the scanner's normal ranges. Whenever the RPC rejects a range, it halves it and continues. It also retries rate-limited and transient failures with exponential backoff. `--chunk <blocks>` caps every `eth_getLogs` query from the start, which avoids those rejected queries on a plan with a known limit:

```bash
bun src/index.ts private-assets \
  --file ./backup.fiberseed \
  --rpc-url https://your-rpc.example \
  --chunk 100
```

Small ranges mean many more requests. A full Base scan at 100 blocks per query can take hours on a free plan, so a paid or self-hosted RPC is much faster.

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

## 4. Recover private assets (signs and sends transactions)

`recover` moves an ERC-20 out of the private pool without the Fiber app. Unlike the other commands, it **signs and sends transactions**. It unshields the token to one of your own EVM accounts, which also signs and pays gas. If the token is an ERC-4626 vault share, `recover` can then redeem it and send the underlying asset to an address you choose.

It is available on Base only, the pool it has been tested on end to end. Railgun's SDK configures Private Proof of Innocence on the other Fiber pools, and `recover` does not generate those proofs.

```bash
bun src/index.ts recover \
  --file ./backup.fiberseed \
  --rpc-url https://your-base-rpc.example \
  --token 0xVaultOrTokenAddress \
  --derivation-index 1 \
  --redeem-to 0xAddressThatReceivesTheUnderlyingAsset \
  --dry-run
```

`--derivation-index` is required and selects the account that receives the unshield, signs, and pays gas. Fiber's accounts start at index 1. To see which address each index controls, run `private-key --derivation-index 1-20` (see [Several accounts at once](#several-accounts-at-once)). The plan also prints the signer's address before anything is sent.

**Choose an index Fiber is not actively using.** Fiber uses these accounts as deposit and routing addresses. Its backend can treat tokens that arrive at one of them as a new deposit and move them back into the vault or the private balance, possibly before the redeem is sent. An index that Fiber used as an intermediate deposit address is the riskiest choice. To keep that window short, `recover` sends the redeem as soon as the unshield has one confirmation. If the backend re-deposits the tokens anyway, nothing is lost: they show up again in `private-assets`, and you can run `recover` again.

Before anything is signed, the command:

1. scans the pool like `private-assets` and refuses to continue if the scan is incomplete;
2. downloads Railgun's official proof artifacts and accepts a circuit only if its zkey and wasm match the SHA-256 hashes published in Railgun's SDK, the verifying key inside the zkey equals the official `vkey.json`, and that key equals the one stored in the pool contract;
3. generates the unshield proof and verifies it locally with Groth16;
4. simulates the unshield and the redeem on one block with `eth_simulateV1`, and checks the resulting `Transfer` logs;
5. prices gas, including the L1 data fee on Base, and checks that the signer can pay it;
6. prints the plan with every address in full and the expected amounts.

It sends nothing until you type `CONFIRM`. With `--dry-run` it stops after the plan. It sends the unshield first, waits for one confirmation, and checks the logs. Only then does it re-check and send the redeem, which waits for two confirmations. Without `--redeem-to`, the unshield waits for two confirmations. If the redeem would return more than 0.5% less than simulated, it is not sent. In that case the tokens stay in your signer account.

Requirements and limits:

- The RPC must support `eth_simulateV1`. Without simulation, `recover` refuses to run.
- The signer account needs ETH for gas on Base. The plan shows the maximum cost.
- `--amount` takes a raw integer amount. Without it, the whole spendable balance is unshielded.
- The password must come from the hidden prompt, because the confirmation also reads the terminal.
- Proof artifacts come from `https://ipfs-lb.com/ipfs/QmUsmnK4PFc7zDp2cmC4wBZxYLjNyRgWfs5GNcJJ2uLcpU`, the source Railgun's SDK uses. This is the only network service besides your RPC. Use `--artifacts-dir <dir>` to keep verified artifacts between runs. Cached files are re-verified every time.
- The Fiber app does not learn about the withdrawal right away. It can keep showing the recovered funds in the private balance for several hours, and the withdrawal may never appear in its activity list. To check the pool itself, run `private-assets` instead of retrying `recover`.
- The signer's private key is derived in memory and never printed. Signed transactions go only to the RPC you supplied, through a guard that rejects anything other than the exact transactions in the confirmed plan.

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
