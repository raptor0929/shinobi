import {
  BASE_FEE,
  Contract,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import { publicConfig } from "@/lib/fixtures";

const TX_TIMEOUT = 60;

export type VaultConfigView = {
  mintAuthority: string;
  mintPkHex: string;
  token: string;
  denomination: string;
};

export type DepositStatus = "None" | "Pending" | "Announced" | "Refunded";

export type VaultEvent = {
  name: string;
  key: Uint8Array;
  data: unknown;
  ledger: number;
  txHash: string;
};

function server() {
  const { rpcUrl } = publicConfig();
  return new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
}

function contract() {
  return new Contract(publicConfig().vaultId);
}

export function bytesArg(value: Uint8Array): xdr.ScVal {
  return nativeToScVal(Buffer.from(value), { type: "bytes" });
}

export function addressArg(value: string): xdr.ScVal {
  return nativeToScVal(value, { type: "address" });
}

function ledgerFromCursor(cursor: string): number | undefined {
  const [toid] = cursor.split("-");
  if (!toid || !/^\d+$/.test(toid)) return undefined;
  const ledger = Number(BigInt(toid) >> 32n);
  return Number.isSafeInteger(ledger) && ledger > 0 ? ledger : undefined;
}

async function simulateView(method: string, args: xdr.ScVal[]) {
  const cfg = publicConfig();
  const s = server();
  const account = await s.getAccount(cfg.viewSource);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: cfg.networkPassphrase,
  })
    .addOperation(contract().call(method, ...args))
    .setTimeout(TX_TIMEOUT)
    .build();
  const sim = await s.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`${method} simulation failed: ${sim.error}`);
  }
  return scValToNative(sim.result!.retval!);
}

export async function fetchVaultConfig(): Promise<VaultConfigView> {
  const raw = (await simulateView("config", [])) as {
    mint_authority: string;
    mint_pk: Buffer | Uint8Array;
    token: string;
    denomination: bigint | number | string;
  };
  const mintPk = Uint8Array.from(raw.mint_pk);
  return {
    mintAuthority: raw.mint_authority,
    mintPkHex: Array.from(mintPk, (b) => b.toString(16).padStart(2, "0")).join(""),
    token: raw.token,
    denomination: String(raw.denomination),
  };
}

export async function depositStatus(depositId: Uint8Array): Promise<DepositStatus> {
  const raw = await simulateView("deposit_status", [bytesArg(depositId)]);
  if (typeof raw === "number") {
    return (["None", "Pending", "Announced", "Refunded"] as const)[raw]!;
  }
  return raw as DepositStatus;
}

export async function isSpent(nullifier: Uint8Array): Promise<boolean> {
  return (await simulateView("is_spent", [bytesArg(nullifier)])) as boolean;
}

export async function getVaultEvents(
  startLedger: number,
  eventName: "announce" | "deposit",
): Promise<{ events: VaultEvent[]; nextLedger: number }> {
  const cfg = publicConfig();
  const s = server();
  const health = await s.getHealth();
  const floor = health.oldestLedger ?? 0;
  const from = Math.max(startLedger, floor);
  const filters = [
    {
      type: "contract" as const,
      contractIds: [cfg.vaultId],
      topics: [[xdr.ScVal.scvSymbol(eventName).toXDR("base64"), "*"]],
    },
  ];

  const events: VaultEvent[] = [];
  let cursor: string | undefined;
  let scannedThrough = from - 1;
  let latestLedger = from;
  const limit = 200;

  for (let page = 0; page < 40; page++) {
    const response = await s.getEvents(
      cursor ? { filters, limit, cursor } : { startLedger: from, filters, limit },
    );
    latestLedger = response.latestLedger;
    for (const raw of response.events) {
      if (raw.topic.length < 2) continue;
      events.push({
        name: String(scValToNative(raw.topic[0]!)),
        key: Uint8Array.from(scValToNative(raw.topic[1]!) as Buffer),
        data: scValToNative(raw.value),
        ledger: raw.ledger,
        txHash: raw.txHash,
      });
    }
    cursor = response.cursor;
    const cursorLedger = cursor ? ledgerFromCursor(cursor) : undefined;
    const truncated = response.events.length >= limit;
    if (cursorLedger !== undefined) {
      scannedThrough = Math.max(scannedThrough, cursorLedger - (truncated ? 1 : 0));
    }
    if (!cursor || (!truncated && scannedThrough >= latestLedger)) {
      scannedThrough = Math.max(scannedThrough, latestLedger);
      break;
    }
  }

  return { events, nextLedger: scannedThrough + 1 };
}

export async function getAnnounceEvents(startLedger: number) {
  return getVaultEvents(startLedger, "announce");
}

export async function getDepositEvents(startLedger: number) {
  return getVaultEvents(startLedger, "deposit");
}

/** Read Depositor(deposit_id) while status is Pending. */
export async function getDepositor(depositId: Uint8Array): Promise<string | null> {
  const cfg = publicConfig();
  const s = server();
  const key = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Depositor"),
    xdr.ScVal.scvBytes(Buffer.from(depositId)),
  ]);
  try {
    const entry = await s.getContractData(
      cfg.vaultId,
      key,
      rpc.Durability.Persistent,
    );
    const value = entry.val.contractData().val();
    return String(scValToNative(value));
  } catch {
    return null;
  }
}

/** Server-side signed invoke (mint announce, etc.). */
export async function invokeSigned(opts: {
  signerSecret: string;
  method: string;
  args: xdr.ScVal[];
}): Promise<string> {
  const { Keypair } = await import("@stellar/stellar-sdk");
  const cfg = publicConfig();
  const s = server();
  const signer = Keypair.fromSecret(opts.signerSecret);
  const account = await s.getAccount(signer.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: cfg.networkPassphrase,
  })
    .addOperation(contract().call(opts.method, ...opts.args))
    .setTimeout(TX_TIMEOUT)
    .build();

  const sim = await s.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`${opts.method} would fail: ${sim.error}`);
  }
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(signer);
  const sent = await s.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`${opts.method} rejected: ${JSON.stringify(sent.errorResult)}`);
  }
  const final = await s.pollTransaction(sent.hash, {
    attempts: 40,
    sleepStrategy: rpc.LinearSleepStrategy,
  });
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`${opts.method} failed on chain (${final.status}): ${sent.hash}`);
  }
  return sent.hash;
}

export function announceArgs(depositId: Uint8Array, sPrime: Uint8Array) {
  return [bytesArg(depositId), bytesArg(sPrime)];
}

export async function prepareContractInvoke(opts: {
  sourcePublicKey: string;
  method: string;
  args: xdr.ScVal[];
}): Promise<{ xdr: string; networkPassphrase: string }> {
  const cfg = publicConfig();
  const s = server();
  const account = await s.getAccount(opts.sourcePublicKey);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: cfg.networkPassphrase,
  })
    .addOperation(contract().call(opts.method, ...opts.args))
    .setTimeout(TX_TIMEOUT)
    .build();

  const sim = await s.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`${opts.method} would fail: ${sim.error}`);
  }
  const prepared = rpc.assembleTransaction(tx, sim).build();
  return { xdr: prepared.toXDR(), networkPassphrase: cfg.networkPassphrase };
}

export function depositArgs(
  depositor: string,
  depositId: Uint8Array,
  blindedB: Uint8Array,
) {
  return [addressArg(depositor), bytesArg(depositId), bytesArg(blindedB)];
}

export function refundArgs(depositId: Uint8Array) {
  return [bytesArg(depositId)];
}

export async function submitSignedXdr(signedXdr: string): Promise<string> {
  const cfg = publicConfig();
  const s = server();
  const parsed = new Transaction(signedXdr, cfg.networkPassphrase);
  const sent = await s.sendTransaction(parsed);
  if (sent.status === "ERROR") {
    throw new Error(`RPC rejected tx: ${JSON.stringify(sent.errorResult)}`);
  }
  const final = await s.pollTransaction(sent.hash, {
    attempts: 40,
    sleepStrategy: rpc.LinearSleepStrategy,
  });
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`tx failed on chain (${final.status}): ${sent.hash}`);
  }
  return sent.hash;
}

export async function latestLedger(): Promise<number> {
  const health = await server().getHealth();
  return health.latestLedger;
}

export { server };
