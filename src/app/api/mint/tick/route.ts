import { NextResponse } from "next/server";
import {
  blindSign,
  deserializeG1,
  fromHex,
  mintKeypairFromSeed,
  serializeG1,
  toHex,
} from "@cpp/client/crypto";
import {
  announceArgs,
  depositStatus,
  fetchVaultConfig,
  getDepositEvents,
  getDepositor,
  invokeSigned,
  latestLedger,
} from "@/lib/vault";

export const runtime = "nodejs";
export const maxDuration = 60;

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function asBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (Buffer.isBuffer(data)) return Uint8Array.from(data);
  if (typeof data === "string") {
    // hex or base64 — deposit event data is bytes via scValToNative → Buffer
    throw new Error("unexpected string event data");
  }
  throw new Error(`unexpected blinded B payload: ${typeof data}`);
}

/**
 * Demo Compliance Tick — one-shot mint announce (not a long-lived daemon).
 * Requires MINT_AUTHORITY_SECRET + MINT_SEED matching the deployed vault.
 */
export async function POST(req: Request) {
  try {
    const authoritySecret = process.env.MINT_AUTHORITY_SECRET;
    const mintSeedHex = process.env.MINT_SEED;
    if (!authoritySecret || !mintSeedHex) {
      return NextResponse.json(
        {
          error:
            "MINT_AUTHORITY_SECRET and MINT_SEED must be set (demo compliance tick)",
        },
        { status: 503 },
      );
    }

    const body = (await req.json()) as {
      depositIdHex?: string;
      startLedger?: number;
    };
    if (!body.depositIdHex) {
      return NextResponse.json({ error: "depositIdHex required" }, { status: 400 });
    }

    const depositId = fromHex(body.depositIdHex);
    const status = await depositStatus(depositId);
    if (status === "Announced") {
      return NextResponse.json({
        decision: "already",
        status,
        message: "Already announced — UI poll should pick it up",
      });
    }
    if (status === "Refunded") {
      return NextResponse.json(
        { error: "Deposit was refunded", status },
        { status: 409 },
      );
    }
    if (status !== "Pending") {
      return NextResponse.json(
        { error: `Deposit not pending (status=${status})`, status },
        { status: 409 },
      );
    }

    const vaultCfg = await fetchVaultConfig();
    const mintKeys = mintKeypairFromSeed(fromHex(mintSeedHex));
    const pkHex = toHex(mintKeys.pk);
    if (pkHex !== vaultCfg.mintPkHex) {
      return NextResponse.json(
        {
          error:
            "MINT_SEED does not match vault mint_pk — refuse to announce with wrong key",
          vaultMintPk: vaultCfg.mintPkHex.slice(0, 16) + "…",
          derivedPk: pkHex.slice(0, 16) + "…",
        },
        { status: 400 },
      );
    }

    if (vaultCfg.mintAuthority) {
      // Soft check: authority secret should control mint_authority address
      const { Keypair } = await import("@stellar/stellar-sdk");
      const authority = Keypair.fromSecret(authoritySecret);
      if (authority.publicKey() !== vaultCfg.mintAuthority) {
        return NextResponse.json(
          {
            error: "MINT_AUTHORITY_SECRET does not match vault mint_authority",
            expected: vaultCfg.mintAuthority,
            got: authority.publicKey(),
          },
          { status: 400 },
        );
      }
    }

    const depositor = await getDepositor(depositId);
    if (!depositor) {
      return NextResponse.json(
        {
          error:
            "No pending depositor entry — already announced, refunded, or unknown",
        },
        { status: 409 },
      );
    }

    const tip = await latestLedger();
    const start = Math.max(0, body.startLedger ?? tip - 2000);
    const page = await getDepositEvents(start);
    const match = page.events.find((ev) => equalBytes(ev.key, depositId));
    if (!match) {
      return NextResponse.json(
        {
          error:
            "Deposit event not found in recent ledgers — try again with an earlier startLedger",
          startLedger: start,
          scannedTo: page.nextLedger,
        },
        { status: 404 },
      );
    }

    // Demo policy: allow all (operator tick). Real mint uses screening providers.
    const blindedB = deserializeG1(asBytes(match.data));
    const sPrime = serializeG1(blindSign(blindedB, mintKeys.sk));

    const announceTx = await invokeSigned({
      signerSecret: authoritySecret,
      method: "announce",
      args: announceArgs(depositId, sPrime),
    });

    return NextResponse.json({
      decision: "allow",
      depositor,
      announceTx,
      depositIdHex: body.depositIdHex,
      policy: "demo-allow-all",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
