import {
  Address,
} from "@stellar/stellar-sdk";
import {
  REDEEM_DOMAIN,
  blindToken,
  concatBytes,
  deserializeG1,
  fromHex,
  serializeG1,
  signRedemption,
  toHex,
  unblindSignature,
  verifyBlindSignature,
  type TokenSecrets,
} from "@cpp/client/crypto";
import { publicConfig } from "@/lib/fixtures";

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function buildRedemptionMessage(vaultId: string, recipient: string): Uint8Array {
  return concatBytes(
    REDEEM_DOMAIN,
    Uint8Array.from(Address.fromString(vaultId).toScVal().toXDR()),
    Uint8Array.from(Address.fromString(recipient).toScVal().toXDR()),
  );
}

export function prepareDepositBlind(token: TokenSecrets): {
  depositIdHex: string;
  blindedBHex: string;
} {
  const { B } = blindToken(token.nullifier, token.r);
  return {
    depositIdHex: toHex(token.depositId),
    blindedBHex: toHex(serializeG1(B)),
  };
}

export function unblindAndVerify(opts: {
  sPrimeBytes: Uint8Array;
  token: TokenSecrets;
  mintPkHex: string;
}): { unblindedSHex: string; ok: boolean } {
  const S = unblindSignature(deserializeG1(opts.sPrimeBytes), opts.token.r);
  const sBytes = serializeG1(S);
  const ok = verifyBlindSignature(
    sBytes,
    opts.token.nullifier,
    fromHex(opts.mintPkHex),
  );
  return { unblindedSHex: toHex(sBytes), ok };
}

export function packageRedeem(opts: {
  token: TokenSecrets;
  recipient: string;
  unblindedSHex: string;
}): {
  recipient: string;
  nullifierHex: string;
  spendSigHex: string;
  unblindedSHex: string;
} {
  const vaultId = publicConfig().vaultId;
  const message = buildRedemptionMessage(vaultId, opts.recipient);
  const spendSig = signRedemption(opts.token.spendSecret, message);
  return {
    recipient: opts.recipient,
    nullifierHex: toHex(opts.token.nullifier),
    spendSigHex: toHex(spendSig),
    unblindedSHex: opts.unblindedSHex,
  };
}
