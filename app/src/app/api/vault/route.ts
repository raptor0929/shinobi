import { NextResponse } from "next/server";
import { fetchVaultConfig, getAnnounceEvents, depositStatus, isSpent, latestLedger } from "@/lib/vault";
import { fromHex } from "@cpp/client/crypto";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const op = url.searchParams.get("op") ?? "config";

  try {
    if (op === "config") {
      const config = await fetchVaultConfig();
      return NextResponse.json(config);
    }
    if (op === "ledger") {
      return NextResponse.json({ latestLedger: await latestLedger() });
    }
    if (op === "announce") {
      const start = Number(url.searchParams.get("start") ?? "0");
      const page = await getAnnounceEvents(start);
      return NextResponse.json({
        nextLedger: page.nextLedger,
        events: page.events.map((e) => ({
          name: e.name,
          keyHex: Array.from(e.key, (b) => b.toString(16).padStart(2, "0")).join(""),
          dataHex:
            e.data instanceof Uint8Array || Buffer.isBuffer(e.data)
              ? Array.from(Uint8Array.from(e.data as Buffer), (b) =>
                  b.toString(16).padStart(2, "0"),
                ).join("")
              : null,
          ledger: e.ledger,
          txHash: e.txHash,
        })),
      });
    }
    if (op === "status") {
      const depositIdHex = url.searchParams.get("depositId");
      if (!depositIdHex) {
        return NextResponse.json({ error: "depositId required" }, { status: 400 });
      }
      const status = await depositStatus(fromHex(depositIdHex));
      return NextResponse.json({ status });
    }
    if (op === "spent") {
      const nullifierHex = url.searchParams.get("nullifier");
      if (!nullifierHex) {
        return NextResponse.json({ error: "nullifier required" }, { status: 400 });
      }
      const spent = await isSpent(fromHex(nullifierHex));
      return NextResponse.json({ spent });
    }
    return NextResponse.json({ error: `unknown op ${op}` }, { status: 400 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
