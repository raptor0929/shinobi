import { NextResponse } from "next/server";
import { fromHex } from "@cpp/client/crypto";
import { depositArgs, prepareContractInvoke, refundArgs } from "@/lib/vault";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      method?: "deposit" | "refund";
      sourcePublicKey?: string;
      depositIdHex?: string;
      blindedBHex?: string;
    };
    if (!body.method || !body.sourcePublicKey) {
      return NextResponse.json(
        { error: "method and sourcePublicKey required" },
        { status: 400 },
      );
    }
    if (body.method === "deposit") {
      if (!body.depositIdHex || !body.blindedBHex) {
        return NextResponse.json(
          { error: "depositIdHex and blindedBHex required" },
          { status: 400 },
        );
      }
      const prepared = await prepareContractInvoke({
        sourcePublicKey: body.sourcePublicKey,
        method: "deposit",
        args: depositArgs(
          body.sourcePublicKey,
          fromHex(body.depositIdHex),
          fromHex(body.blindedBHex),
        ),
      });
      return NextResponse.json(prepared);
    }
    if (body.method === "refund") {
      if (!body.depositIdHex) {
        return NextResponse.json({ error: "depositIdHex required" }, { status: 400 });
      }
      const prepared = await prepareContractInvoke({
        sourcePublicKey: body.sourcePublicKey,
        method: "refund",
        args: refundArgs(fromHex(body.depositIdHex)),
      });
      return NextResponse.json(prepared);
    }
    return NextResponse.json({ error: "unknown method" }, { status: 400 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
