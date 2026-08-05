import { NextResponse } from "next/server";
import { submitSignedXdr } from "@/lib/vault";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { signedXdr?: string };
    if (!body.signedXdr) {
      return NextResponse.json({ error: "signedXdr required" }, { status: 400 });
    }
    const hash = await submitSignedXdr(body.signedXdr);
    return NextResponse.json({ hash });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
