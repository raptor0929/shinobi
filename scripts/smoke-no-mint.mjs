#!/usr/bin/env node
/**
 * Smoke test without MINT_* keys.
 * Covers: vault reads, mint/tick 503, prepare deposit XDR, privacy rejects,
 * optional sponsor create. Does NOT announce or redeem (needs mint).
 *
 * Usage: node scripts/smoke-no-mint.mjs [baseUrl]
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.argv[2] ?? "http://localhost:3000";

/** Fixed deriveTokenSecrets(seed=[7..], 0) + blind — valid G1 for prepare smoke. */
const SMOKE_DEPOSIT = {
  depositIdHex:
    "03d0aae8f090c14a095f07c5249b34d1fe0a283a506ea5c33b8ce7986a3b3949",
  blindedBHex:
    "19b0248bf0a630f2295e2cf71e2f1e0e9955988ae4cab22f0b2e5962a7e941996c8e65193f22426006236d88d0b03d9c166fb85433e6fa2d12941e0f277843ec0c17520c78feced6a83850c3e8c5fc8bd5078e8cdaa729bf624502c92735b8c0",
};

function loadEnvLocal() {
  const p = resolve(ROOT, ".env.local");
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}

function ok(name, detail = "") {
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail) {
  console.error(`FAIL  ${name} — ${detail}`);
  process.exitCode = 1;
}

async function json(res) {
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { raw: text.slice(0, 200) } };
  }
}

async function main() {
  const env = loadEnvLocal();
  console.log(`\nSmoke (no mint) → ${BASE}\n`);

  // --- env expectations ---
  if (env.SPONSOR_SECRET) ok("env SPONSOR_SECRET", "set");
  else fail("env SPONSOR_SECRET", "missing");
  if (env.RELAYER_SECRET) ok("env RELAYER_SECRET", "set");
  else fail("env RELAYER_SECRET", "missing");
  if (!env.MINT_AUTHORITY_SECRET && !env.MINT_SEED) {
    ok("env MINT_*", "absent (expected for this smoke)");
  } else {
    ok("env MINT_*", "present — tick may succeed instead of 503");
  }

  // --- vault ---
  {
    const r = await json(await fetch(`${BASE}/api/vault?op=config`));
    if (r.status === 200 && r.body.mintAuthority && r.body.mintPkHex) {
      ok(
        "GET /api/vault?op=config",
        `authority=${String(r.body.mintAuthority).slice(0, 8)}… denomination=${r.body.denomination}`,
      );
    } else fail("GET /api/vault?op=config", JSON.stringify(r));
  }
  {
    const r = await json(await fetch(`${BASE}/api/vault?op=ledger`));
    if (r.status === 200 && typeof r.body.latestLedger === "number") {
      ok("GET /api/vault?op=ledger", `ledger=${r.body.latestLedger}`);
    } else fail("GET /api/vault?op=ledger", JSON.stringify(r));
  }

  // --- mint tick must refuse without keys ---
  {
    const r = await json(
      await fetch(`${BASE}/api/mint/tick`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          depositIdHex: "00".repeat(32),
          startLedger: 0,
        }),
      }),
    );
    if (!env.MINT_AUTHORITY_SECRET || !env.MINT_SEED) {
      if (r.status === 503 && /MINT_/.test(String(r.body.error ?? ""))) {
        ok("POST /api/mint/tick", `503 as expected: ${r.body.error}`);
      } else {
        fail("POST /api/mint/tick", `expected 503 MINT_*, got ${JSON.stringify(r)}`);
      }
    } else if (r.status === 400 || r.status === 409 || r.status === 200) {
      ok("POST /api/mint/tick", `keys present → ${r.status}`);
    } else {
      fail("POST /api/mint/tick", JSON.stringify(r));
    }
  }

  // --- prepare deposit XDR (no Freighter submit) ---
  {
    const depositor =
      env.NEXT_PUBLIC_DEPOSITOR_HINT ||
      "GBAI6UEOFNDJR5TNJLOJRQUAMGC7BA3OW5AOQ7QMWKK2XKZCGGV4ZSKY";
    const r = await json(
      await fetch(`${BASE}/api/prepare`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          method: "deposit",
          sourcePublicKey: depositor,
          ...SMOKE_DEPOSIT,
        }),
      }),
    );
    if (r.status === 200 && typeof r.body.xdr === "string" && r.body.xdr.length > 20) {
      ok("POST /api/prepare deposit", `xdr length=${r.body.xdr.length}`);
    } else {
      fail("POST /api/prepare deposit", JSON.stringify(r));
    }
  }

  // --- privacy guards ---
  {
    const r = await json(
      await fetch(`${BASE}/api/relayer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipient: "GB4ZYWZDI5IVECQY7NOK5G24RCZJK7G5ZV3C5CQJ6BDIOBILBW2TV2JP",
          nullifierHex: "00".repeat(32),
          spendSigHex: "00".repeat(32),
          unblindedSHex: "00".repeat(48),
          seed: "should-reject",
        }),
      }),
    );
    if (r.status === 400 && /seed|blinding/i.test(String(r.body.error ?? ""))) {
      ok("POST /api/relayer rejects seed", r.body.error);
    } else fail("POST /api/relayer rejects seed", JSON.stringify(r));
  }
  {
    const r = await json(
      await fetch(`${BASE}/api/sponsor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deposit_id: "nope" }),
      }),
    );
    if (r.status === 400) ok("POST /api/sponsor rejects deposit_id", r.body.error);
    else fail("POST /api/sponsor rejects deposit_id", JSON.stringify(r));
  }

  // --- live sponsor (creates a real testnet account) ---
  if (env.SPONSOR_SECRET) {
    const r = await json(
      await fetch(`${BASE}/api/sponsor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    if (r.status === 200 && typeof r.body.publicKey === "string") {
      ok("POST /api/sponsor create", r.body.publicKey);
    } else fail("POST /api/sponsor create", JSON.stringify(r));
  }

  console.log(
    process.exitCode
      ? "\nSmoke finished with failures.\n"
      : "\nSmoke OK (no mint). Freighter deposit → reclaim still manual; announce/redeem blocked until MINT_*.\n",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
