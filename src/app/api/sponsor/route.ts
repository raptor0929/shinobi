import { NextResponse } from "next/server";
import {
  Account,
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import { publicConfig } from "@/lib/fixtures";

export const runtime = "nodejs";

const CLASSIC_FEE_PER_OP = "10000";

/**
 * Demo Sponsor — creates a Sponsored Recipient under one shared key.
 * Rejects deposit_id / seed / blinding (privacy).
 */
export async function POST(req: Request) {
  try {
    const secret = process.env.SPONSOR_SECRET;
    if (!secret) {
      return NextResponse.json(
        { error: "SPONSOR_SECRET not configured on server" },
        { status: 503 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if ("deposit_id" in body || "depositId" in body) {
      return NextResponse.json(
        { error: "sponsor must not receive deposit_id" },
        { status: 400 },
      );
    }
    if ("seed" in body || "blinding" in body || "r" in body) {
      return NextResponse.json({ error: "forbidden field" }, { status: 400 });
    }

    const cfg = publicConfig();
    const sponsor = Keypair.fromSecret(secret);
    if (
      typeof body.depositorPublicKey === "string" &&
      body.depositorPublicKey === sponsor.publicKey()
    ) {
      return NextResponse.json(
        { error: "sponsor must not be the depositor" },
        { status: 400 },
      );
    }

    const account = Keypair.random();
    const server = new rpc.Server(cfg.rpcUrl, {
      allowHttp: cfg.rpcUrl.startsWith("http://"),
    });
    const source = await server.getAccount(sponsor.publicKey());
    const tx = new TransactionBuilder(
      new Account(source.accountId(), source.sequenceNumber()),
      { fee: CLASSIC_FEE_PER_OP, networkPassphrase: cfg.networkPassphrase },
    )
      .addOperation(
        Operation.beginSponsoringFutureReserves({ sponsoredId: account.publicKey() }),
      )
      .addOperation(
        Operation.createAccount({
          destination: account.publicKey(),
          startingBalance: "0",
        }),
      )
      .addOperation(
        Operation.endSponsoringFutureReserves({ source: account.publicKey() }),
      )
      .setTimeout(60)
      .build();

    tx.sign(sponsor, account);
    const sent = await server.sendTransaction(tx);
    if (sent.status === "ERROR") {
      throw new Error(`sponsored creation rejected: ${JSON.stringify(sent.errorResult)}`);
    }
    const final = await server.pollTransaction(sent.hash, {
      attempts: 30,
      sleepStrategy: rpc.LinearSleepStrategy,
    });
    if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`sponsored creation failed (${final.status})`);
    }

    return NextResponse.json({
      publicKey: account.publicKey(),
      secret: account.secret(),
      txHash: sent.hash,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
