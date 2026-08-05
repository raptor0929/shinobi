#!/usr/bin/env node
/**
 * Creates funded testnet operator keys for the Demo Relayer + Demo Sponsor
 * and appends them to .env.local. Secrets are written locally only — do not
 * paste them into chat or commit .env.local.
 *
 * Usage: node scripts/bootstrap-operator-keys.mjs
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";

const ROOT = resolve(import.meta.dirname, "..");
const ENV_PATH = resolve(ROOT, ".env.local");
const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";

function parseEnv(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function fund(publicKey) {
  const url = `${FRIENDBOT}?addr=${encodeURIComponent(publicKey)}`;
  const res = await fetch(url);
  const body = await res.text();
  if (!res.ok) {
    // Already funded is fine — friendbot often 400s on re-fund.
    if (body.includes("op_already_exists") || body.includes("create_account")) {
      return { ok: true, note: "already exists / funded" };
    }
    throw new Error(`friendbot failed for ${publicKey}: ${res.status} ${body.slice(0, 200)}`);
  }
  return { ok: true, note: "funded" };
}

async function balance(publicKey) {
  const res = await fetch(`${HORIZON}/accounts/${publicKey}`);
  if (!res.ok) return null;
  const j = await res.json();
  const native = (j.balances || []).find((b) => b.asset_type === "native");
  return native?.balance ?? null;
}

async function main() {
  let existing = {};
  if (existsSync(ENV_PATH)) {
    existing = parseEnv(readFileSync(ENV_PATH, "utf8"));
  } else if (existsSync(resolve(ROOT, ".env.example"))) {
    writeFileSync(ENV_PATH, readFileSync(resolve(ROOT, ".env.example"), "utf8"));
    existing = parseEnv(readFileSync(ENV_PATH, "utf8"));
    console.log("Created .env.local from .env.example");
  }

  const relayer =
    existing.RELAYER_SECRET || existing.SUBMITTER_SECRET
      ? Keypair.fromSecret(existing.RELAYER_SECRET || existing.SUBMITTER_SECRET)
      : Keypair.random();
  const sponsor = existing.SPONSOR_SECRET
    ? Keypair.fromSecret(existing.SPONSOR_SECRET)
    : Keypair.random();

  if (relayer.publicKey() === sponsor.publicKey()) {
    throw new Error("Relayer and sponsor must be different accounts");
  }

  console.log("Relayer G…", relayer.publicKey());
  console.log("Sponsor G…", sponsor.publicKey());

  console.log("Funding via Friendbot…");
  console.log("  relayer:", (await fund(relayer.publicKey())).note);
  console.log("  sponsor:", (await fund(sponsor.publicKey())).note);

  // Small wait for Horizon
  await new Promise((r) => setTimeout(r, 2000));
  console.log("  relayer balance:", (await balance(relayer.publicKey())) ?? "pending");
  console.log("  sponsor balance:", (await balance(sponsor.publicKey())) ?? "pending");

  const lines = [];
  if (!existing.RELAYER_SECRET && !existing.SUBMITTER_SECRET) {
    lines.push(`RELAYER_SECRET=${relayer.secret()}`);
  }
  if (!existing.SPONSOR_SECRET) {
    lines.push(`SPONSOR_SECRET=${sponsor.secret()}`);
  }

  if (lines.length) {
    appendFileSync(ENV_PATH, `\n# Operator keys (bootstrap ${new Date().toISOString()})\n${lines.join("\n")}\n`);
    console.log(`Wrote ${lines.length} secret(s) into .env.local`);
  } else {
    console.log(".env.local already had RELAYER_SECRET and SPONSOR_SECRET — left unchanged");
  }

  console.log(`
Next:
  1. Restart \`npm run dev\` so Next.js picks up .env.local
  2. Freighter = depositor (fixture GBAI6… or any funded testnet account)
  3. Add MINT_AUTHORITY_SECRET + MINT_SEED (matching vault) for Run compliance → /api/mint/tick
  4. Demo Recipient Preset GB4ZY… is already set — redeem does not need sponsor unless you click Create Sponsored Recipient
`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
