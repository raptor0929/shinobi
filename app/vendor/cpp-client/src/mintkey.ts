#!/usr/bin/env node
/**
 * Derives the mint's BLS12-381 public key from its seed.
 *
 *   npm run mintkey                  generate a fresh seed and print both halves
 *   npm run mintkey -- --seed <hex>  derive from an existing seed
 *   npm run mintkey -- --pk-only     print only the 192-byte public key
 *
 * `deploy.sh` uses `--pk-only` to pass the key to the constructor. The seed
 * itself is the mint's whole identity: whoever holds it can sign tokens the
 * vault will honour, and losing it strands every deposit the vault has not yet
 * announced. It never needs to be online anywhere but the mint daemon.
 */

import { randomBytes } from "node:crypto";

import { fromHex, mintKeypairFromSeed, scalarToBytes, toHex } from "./crypto.js";

function main(): void {
  const argv = process.argv.slice(2);
  const seedIndex = argv.indexOf("--seed");
  const seed =
    seedIndex >= 0 && argv[seedIndex + 1]
      ? fromHex(argv[seedIndex + 1]!)
      : Uint8Array.from(randomBytes(32));

  if (seed.length !== 32) {
    throw new Error(`seed must be 32 bytes, got ${seed.length}`);
  }

  const keys = mintKeypairFromSeed(seed);

  if (argv.includes("--pk-only")) {
    process.stdout.write(toHex(keys.pk));
    return;
  }

  console.log(`MINT_SEED=${toHex(seed)}`);
  console.log(`# scalar  ${toHex(scalarToBytes(keys.sk))}`);
  console.log(`# pk (G2) ${toHex(keys.pk)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
