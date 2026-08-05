"use client";

import {
  isConnected,
  isAllowed,
  requestAccess,
  getAddress,
  signTransaction,
} from "@stellar/freighter-api";
import { publicConfig } from "@/lib/fixtures";

export async function connectFreighter(): Promise<string> {
  const connected = await isConnected();
  if (!connected.isConnected) {
    throw new Error("Freighter is not installed or not available");
  }
  const allowed = await isAllowed();
  if (!allowed.isAllowed) {
    const access = await requestAccess();
    if (access.error) throw new Error(access.error);
    return access.address!;
  }
  const addr = await getAddress();
  if (addr.error || !addr.address) throw new Error(addr.error ?? "No Freighter address");
  return addr.address;
}

export async function freighterSignAndSubmit(unsignedXdr: string): Promise<string> {
  const cfg = publicConfig();
  const signed = await signTransaction(unsignedXdr, {
    networkPassphrase: cfg.networkPassphrase,
    address: (await getAddress()).address,
  });
  if (signed.error || !signed.signedTxXdr) {
    throw new Error(signed.error ?? "Freighter did not return a signature");
  }

  const res = await fetch("/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedXdr: signed.signedTxXdr }),
  });
  const body = (await res.json()) as { hash?: string; error?: string };
  if (!res.ok || !body.hash) throw new Error(body.error ?? "Submit failed");
  return body.hash;
}
