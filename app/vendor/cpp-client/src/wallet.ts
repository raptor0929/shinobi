/**
 * Local wallet state.
 *
 * The file this module manages is a **cache, not the wallet**. Every secret is
 * derived from `seed` and an index, so a lost file costs a scan, not the funds:
 * `client.ts recover` walks indices from zero, re-derives each `deposit_id`,
 * and rebuilds the token list from the chain's `announce` events.
 *
 * What the file cannot be reconstructed from is `seed` itself. That is the one
 * thing worth backing up, and it is why `save` writes with mode 0600.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { resolveFromRoot } from "./config.js";
import { deriveTokenSecrets, fromHex, toHex, type TokenSecrets } from "./crypto.js";

export const DEFAULT_WALLET_PATH = resolveFromRoot(process.env.CPP_WALLET ?? ".cpp/wallet.json");

/** Where a token is in its lifecycle, from the wallet's point of view. */
export type TokenState =
  /** `deposit` submitted; waiting for the mint. */
  | "pending"
  /** `announce` seen and unblinded; `S` is spendable. */
  | "ready"
  /** `redeem` submitted successfully. */
  | "spent"
  /** Reclaimed via `refund`. */
  | "refunded";

export interface TokenRecord {
  index: number;
  state: TokenState;
  depositId: string;
  nullifier: string;
  /** Unblinded signature, hex. Present once the token is `ready`. */
  s?: string;
  depositTx?: string;
  redeemTx?: string;
  /** Where the token was spent. Kept locally only — the chain does not link it. */
  paidTo?: string;
}

export interface WalletFile {
  version: 1;
  /** Master seed, hex. Everything else in this file derives from it. */
  seed: string;
  /** Vault this wallet's tokens belong to; token derivation is vault-agnostic
   *  but a token is only spendable at the vault that minted it. */
  vaultId: string;
  /** Next unused derivation index. */
  nextIndex: number;
  /** Ledger the last `scan` reached, so the next one is incremental. */
  scanCursor?: number;
  tokens: TokenRecord[];
}

export class Wallet {
  private constructor(
    readonly path: string,
    private file: WalletFile,
  ) {}

  static async load(path = DEFAULT_WALLET_PATH): Promise<Wallet> {
    const parsed = JSON.parse(await readFile(path, "utf8")) as WalletFile;
    if (parsed.version !== 1) {
      throw new Error(`unsupported wallet version ${parsed.version}`);
    }
    return new Wallet(path, parsed);
  }

  static async create(
    seed: Uint8Array,
    vaultId: string,
    path = DEFAULT_WALLET_PATH,
  ): Promise<Wallet> {
    const wallet = new Wallet(path, {
      version: 1,
      seed: toHex(seed),
      vaultId,
      nextIndex: 0,
      tokens: [],
    });
    await wallet.save();
    return wallet;
  }

  get seed(): Uint8Array {
    return fromHex(this.file.seed);
  }

  get vaultId(): string {
    return this.file.vaultId;
  }

  get tokens(): readonly TokenRecord[] {
    return this.file.tokens;
  }

  get scanCursor(): number | undefined {
    return this.file.scanCursor;
  }

  secretsFor(index: number): TokenSecrets {
    return deriveTokenSecrets(this.seed, index);
  }

  /** Claims the next derivation index and returns its secrets. */
  allocate(): TokenSecrets {
    return this.secretsFor(this.file.nextIndex++);
  }

  find(index: number): TokenRecord | undefined {
    return this.file.tokens.find((t) => t.index === index);
  }

  findByDepositId(depositIdHex: string): TokenRecord | undefined {
    return this.file.tokens.find((t) => t.depositId === depositIdHex);
  }

  /** Inserts or updates a token record in place. */
  upsert(record: TokenRecord): void {
    const existing = this.file.tokens.findIndex((t) => t.index === record.index);
    if (existing >= 0) {
      this.file.tokens[existing] = { ...this.file.tokens[existing]!, ...record };
    } else {
      this.file.tokens.push(record);
      this.file.tokens.sort((a, b) => a.index - b.index);
    }
    // Keep the allocator ahead of anything recovered from chain, or a later
    // `deposit` would reuse an index the vault has already seen.
    this.file.nextIndex = Math.max(this.file.nextIndex, record.index + 1);
  }

  setScanCursor(ledger: number): void {
    this.file.scanCursor = ledger;
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(this.file, null, 2)}\n`, { mode: 0o600 });
  }
}
