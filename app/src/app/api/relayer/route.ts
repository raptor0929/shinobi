import { NextResponse } from "next/server";
import {
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { fromHex } from "@cpp/client/crypto";
import { publicConfig } from "@/lib/fixtures";

export const runtime = "nodejs";

/**
 * Demo Relayer — submits redeem. Never accepts seed / blinding factor.
 */
export async function POST(req: Request) {
  try {
    const secret = process.env.RELAYER_SECRET ?? process.env.SUBMITTER_SECRET;
    if (!secret) {
      return NextResponse.json(
        { error: "RELAYER_SECRET not configured on server" },
        { status: 503 },
      );
    }

    const body = (await req.json()) as {
      recipient?: string;
      nullifierHex?: string;
      spendSigHex?: string;
      unblindedSHex?: string;
      seed?: unknown;
      r?: unknown;
      blinding?: unknown;
    };

    if (body.seed != null || body.r != null || body.blinding != null) {
      return NextResponse.json(
        { error: "relayer must not receive seed or blinding factor" },
        { status: 400 },
      );
    }

    if (
      !body.recipient ||
      !body.nullifierHex ||
      !body.spendSigHex ||
      !body.unblindedSHex
    ) {
      return NextResponse.json(
        { error: "recipient, nullifierHex, spendSigHex, unblindedSHex required" },
        { status: 400 },
      );
    }

    const cfg = publicConfig();
    const relayer = Keypair.fromSecret(secret);
    const server = new rpc.Server(cfg.rpcUrl, {
      allowHttp: cfg.rpcUrl.startsWith("http://"),
    });
    const contract = new Contract(cfg.vaultId);
    const account = await server.getAccount(relayer.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: cfg.networkPassphrase,
    })
      .addOperation(
        contract.call(
          "redeem",
          nativeToScVal(body.recipient, { type: "address" }),
          nativeToScVal(Buffer.from(fromHex(body.nullifierHex)), { type: "bytes" }),
          nativeToScVal(Buffer.from(fromHex(body.spendSigHex)), { type: "bytes" }),
          nativeToScVal(Buffer.from(fromHex(body.unblindedSHex)), { type: "bytes" }),
        ),
      )
      .setTimeout(60)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`redeem would fail: ${sim.error}`);
    }
    const prepared = rpc.assembleTransaction(tx, sim).build();
    prepared.sign(relayer);
    const sent = await server.sendTransaction(prepared);
    if (sent.status === "ERROR") {
      throw new Error(`redeem rejected: ${JSON.stringify(sent.errorResult)}`);
    }
    const final = await server.pollTransaction(sent.hash, {
      attempts: 40,
      sleepStrategy: rpc.LinearSleepStrategy,
    });
    if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`redeem failed on chain (${final.status}): ${sent.hash}`);
    }

    return NextResponse.json({
      hash: sent.hash,
      relayerPublicKey: relayer.publicKey(),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
