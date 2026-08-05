/** Demo Fixtures + public network config (safe for the browser). */

export const FIXTURES = {
  vault: "CB72LNFU3AWO34Q5PFV7NKINO5KVTQIXYE4PCH4TE32T7I6K2OL5QCFA",
  depositorHint: "GBAI6UEOFNDJR5TNJLOJRQUAMGC7BA3OW5AOQ7QMWKK2XKZCGGV4ZSKY",
  mintAuthority: "GA3XNGP3XILRTOVEVPDOXEC2NJMR47QCD2CACWWPCLZ76V76QNK57CZL",
  recipientPreset: "GB4ZYWZDI5IVECQY7NOK5G24RCZJK7G5ZV3C5CQJ6BDIOBILBW2TV2JP",
} as const;

export function publicConfig() {
  return {
    network: "testnet" as const,
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl:
      process.env.NEXT_PUBLIC_RPC_URL ?? "https://soroban-testnet.stellar.org",
    horizonUrl:
      process.env.NEXT_PUBLIC_HORIZON_URL ??
      "https://horizon-testnet.stellar.org",
    vaultId: process.env.NEXT_PUBLIC_VAULT_CONTRACT_ID ?? FIXTURES.vault,
    recipientPreset:
      process.env.NEXT_PUBLIC_RECIPIENT_PRESET ?? FIXTURES.recipientPreset,
    depositorHint:
      process.env.NEXT_PUBLIC_DEPOSITOR_HINT ?? FIXTURES.depositorHint,
    mintAuthority:
      process.env.NEXT_PUBLIC_MINT_AUTHORITY ?? FIXTURES.mintAuthority,
    /** Funded account used only to simulate view calls. */
    viewSource:
      process.env.NEXT_PUBLIC_VIEW_SOURCE ?? FIXTURES.depositorHint,
    expertBase: "https://stellar.expert/explorer/testnet",
  };
}

export type PublicConfig = ReturnType<typeof publicConfig>;
