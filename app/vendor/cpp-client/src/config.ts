import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { Networks } from "@stellar/stellar-sdk";

/**
 * The directory holding `.env`, which is also where relative paths in the
 * environment are anchored.
 *
 * `npm --prefix ts run client` executes with `ts/` as the working directory, so
 * a bare `scripts/denylist.json` in `.env` would resolve to `ts/scripts/…` and
 * the mint would fail to start. Anchoring on the `.env` file itself makes the
 * same configuration work from either directory.
 */
export function projectRoot(): string {
  for (const candidate of [".", ".."]) {
    if (existsSync(resolve(process.cwd(), candidate, ".env"))) {
      return resolve(process.cwd(), candidate);
    }
  }
  return process.cwd();
}

/** Resolves a possibly-relative path from the environment against the root. */
export function resolveFromRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(projectRoot(), path);
}

/**
 * Loads `.env` if it exists.
 *
 * Uses Node's built-in loader rather than a dependency, and never overrides a
 * variable that is already set — so `VAULT_CONTRACT_ID=… npm run client` still
 * beats whatever `deploy.sh` wrote.
 */
function loadDotEnv(): void {
  const path = resolve(projectRoot(), ".env");
  if (existsSync(path)) process.loadEnvFile(path);
}

/** Shape of the environment every CLI entry point reads. */
export interface Config {
  rpcUrl: string;
  networkPassphrase: string;
  vaultId: string;
}

const DEFAULT_RPC: Record<string, string> = {
  [Networks.TESTNET]: "https://soroban-testnet.stellar.org",
  [Networks.PUBLIC]: "https://mainnet.sorobanrpc.com",
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set — copy example.env to .env and fill it in`);
  }
  return value;
}

export function loadConfig(): Config {
  loadDotEnv();

  const network = (process.env.STELLAR_NETWORK ?? "testnet").toLowerCase();
  const networkPassphrase =
    network === "public" || network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

  return {
    rpcUrl: process.env.STELLAR_RPC_URL ?? DEFAULT_RPC[networkPassphrase]!,
    networkPassphrase,
    vaultId: required("VAULT_CONTRACT_ID"),
  };
}

/** Reads a hex-encoded value from the environment, tolerating a `0x` prefix. */
export function requiredHex(name: string, byteLength: number): Uint8Array {
  const raw = required(name).replace(/^0x/, "");
  if (raw.length !== byteLength * 2) {
    throw new Error(`${name} must be ${byteLength} bytes (${byteLength * 2} hex chars), got ${raw.length / 2}`);
  }
  return Uint8Array.from(Buffer.from(raw, "hex"));
}
