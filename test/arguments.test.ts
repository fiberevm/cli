import { describe, expect, it } from "bun:test";
import { parseCliArguments } from "../src/arguments.ts";

describe("Fiber CLI arguments", () => {
  it("requires an explicit RPC URL for private asset scans", () => {
    expect(() => parseCliArguments(["private-assets", "--file", "backup.fiberseed"])).toThrow(
      "there is no default RPC URL",
    );
  });

  it("rejects passwords in process-visible arguments", () => {
    expect(() =>
      parseCliArguments([
        "private-key",
        "--file",
        "backup.fiberseed",
        "--password",
        "do-not-leak-this",
      ]),
    ).toThrow("Do not pass passwords as arguments");
  });

  it("parses an explicit RPC and stdin password mode", () => {
    expect(
      parseCliArguments([
        "private-assets",
        "--file",
        "backup.fiberseed",
        "--rpc-url",
        "https://rpc.example",
        "--password-stdin",
        "--json",
      ]),
    ).toEqual({
      command: "private-assets",
      file: "backup.fiberseed",
      rpcUrl: "https://rpc.example",
      passwordStdin: true,
      json: true,
    });
  });

  it("selects EVM keys by default and accepts explicit Solana recovery", () => {
    expect(parseCliArguments(["private-key", "--file", "backup.fiberseed"])).toMatchObject({
      command: "private-key",
      chain: "evm",
    });
    expect(
      parseCliArguments([
        "private-key",
        "--file",
        "backup.fiberseed",
        "--chain",
        "solana",
      ]),
    ).toMatchObject({ command: "private-key", chain: "solana" });
  });

  it("rejects unsupported key chains", () => {
    expect(() =>
      parseCliArguments([
        "private-key",
        "--file",
        "backup.fiberseed",
        "--chain",
        "bitcoin",
      ]),
    ).toThrow("--chain must be evm or solana");
  });

  it("rejects EVM derivation options on a private asset scan", () => {
    expect(() =>
      parseCliArguments([
        "private-assets",
        "--file",
        "backup.fiberseed",
        "--rpc-url",
        "https://rpc.example",
        "--derivation-index",
        "1",
      ]),
    ).toThrow("only valid for private-key");
  });

  it("rejects unsafe RPC transports before asking for a password", () => {
    expect(() =>
      parseCliArguments([
        "private-assets",
        "--file",
        "backup.fiberseed",
        "--rpc-url",
        "file:///tmp/rpc",
      ]),
    ).toThrow("valid http or https URL");
  });

  it("does not accept key selection on a private asset scan", () => {
    expect(() =>
      parseCliArguments([
        "private-assets",
        "--file",
        "backup.fiberseed",
        "--rpc-url",
        "https://rpc.example",
        "--chain",
        "evm",
      ]),
    ).toThrow("--chain is only valid for private-key");
  });

  it("parses an eth_getLogs chunk size for private asset scans", () => {
    expect(
      parseCliArguments([
        "private-assets",
        "--file",
        "backup.fiberseed",
        "--rpc-url",
        "https://rpc.example",
        "--chunk",
        "100",
      ]),
    ).toMatchObject({ command: "private-assets", chunkSize: 100 });
    expect(
      parseCliArguments(["private-assets", "--file=b", "--rpc-url=https://rpc.example", "--chunk=250"]),
    ).toMatchObject({ chunkSize: 250 });
  });

  it("rejects invalid chunk sizes and chunks on key recovery", () => {
    for (const value of ["0", "-5", "1.5", "1e2", "abc", "1000001"]) {
      expect(() =>
        parseCliArguments([
          "private-assets",
          "--file",
          "backup.fiberseed",
          "--rpc-url",
          "https://rpc.example",
          "--chunk",
          value,
        ]),
      ).toThrow("--chunk must be an integer from 1 through 1000000");
    }
    expect(() =>
      parseCliArguments(["private-key", "--file", "backup.fiberseed", "--chunk", "100"]),
    ).toThrow("--chunk is only valid for private-assets");
  });

  it("accepts --flag=value and still rejects inline passwords", () => {
    expect(
      parseCliArguments(["private-key", "--file=backup.fiberseed", "--chain=solana"]),
    ).toMatchObject({ file: "backup.fiberseed", chain: "solana" });
    expect(() =>
      parseCliArguments(["private-key", "--file=backup.fiberseed", "--password=do-not-leak-this"]),
    ).toThrow("Do not pass passwords as arguments");
    expect(() => parseCliArguments(["private-key", "--file=backup.fiberseed", "--json=1"])).toThrow(
      "--json does not take a value",
    );
    expect(() => parseCliArguments(["private-key", "--file="])).toThrow("--file requires a value");
  });

  it("parses one derivation index or an inclusive range", () => {
    expect(
      parseCliArguments(["private-key", "--file", "backup.fiberseed", "--derivation-index", "7"]),
    ).toMatchObject({ derivationIndexes: [7] });
    expect(
      parseCliArguments(["private-key", "--file", "backup.fiberseed", "--derivation-index", "0-4"]),
    ).toMatchObject({ derivationIndexes: [0, 1, 2, 3, 4] });
    expect(parseCliArguments(["private-key", "--file", "backup.fiberseed"])).toMatchObject({
      derivationIndexes: [0],
    });
  });

  it("rejects malformed, reversed, and oversized derivation ranges", () => {
    const parseIndex = (value: string) =>
      parseCliArguments(["private-key", "--file", "backup.fiberseed", "--derivation-index", value]);

    expect(() => parseIndex("1e2")).toThrow("must be an integer");
    expect(() => parseIndex("2147483648")).toThrow("must be an integer");
    expect(() => parseIndex("4-2")).toThrow("must not end before it starts");
    expect(() => parseIndex("0-100")).toThrow("at most 100 indexes");
    expect(parseIndex("2147483547-2147483646")).toMatchObject({
      derivationIndexes: expect.arrayContaining([2147483646]),
    });
  });

  it("keeps --output on private-key only", () => {
    expect(
      parseCliArguments(["private-key", "--file", "backup.fiberseed", "--output", "keys.json", "--json"]),
    ).toMatchObject({ output: "keys.json", json: true });
    expect(() =>
      parseCliArguments([
        "private-assets",
        "--file",
        "backup.fiberseed",
        "--rpc-url",
        "https://rpc.example",
        "--output",
        "assets.json",
      ]),
    ).toThrow("--output is only valid for private-key");
  });

  it("routes help and version requests before validating other flags", () => {
    expect(parseCliArguments([])).toEqual({ command: "help" });
    expect(parseCliArguments(["help", "private-assets"])).toEqual({
      command: "help",
      topic: "private-assets",
    });
    expect(parseCliArguments(["private-key", "--chain", "bitcoin", "-h"])).toEqual({
      command: "help",
      topic: "private-key",
    });
    expect(parseCliArguments(["--version"])).toEqual({ command: "version" });
    expect(() => parseCliArguments(["help", "nope"])).toThrow("Unknown command: nope");
  });
});
