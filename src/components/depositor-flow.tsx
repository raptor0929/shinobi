"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { TokenSecrets } from "@cpp/client/crypto";
import { fromHex, toHex } from "@cpp/client/crypto";
import { makeLogEntry, type DemoLogEntry } from "@/lib/demo-log";
import { publicConfig } from "@/lib/fixtures";
import { connectFreighter, freighterSignAndSubmit } from "@/lib/freighter";
import {
  equalBytes,
  packageRedeem,
  prepareDepositBlind,
  unblindAndVerify,
} from "@/lib/redeem";
import {
  clearSeedCache,
  generateTokenSeed,
  hasSeedCache,
  loadSeedCache,
  saveSeedCache,
  secretsAt,
  seedFromHex,
  seedToHex,
} from "@/lib/token-seed";

type Step =
  | "seed"
  | "deposit"
  | "pending"
  | "ready"
  | "proof"
  | "refunded";

type VaultCfg = {
  mintAuthority: string;
  mintPkHex: string;
  token: string;
  denomination: string;
};

function stroopsToXlm(denom: string): string {
  try {
    const n = BigInt(denom);
    const whole = n / 10_000_000n;
    const frac = (n % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : `${whole}`;
  } catch {
    return denom;
  }
}

export function DepositorFlow() {
  const cfg = useMemo(() => publicConfig(), []);
  const [logs, setLogs] = useState<DemoLogEntry[]>([]);
  const log = useCallback((level: DemoLogEntry["level"], message: string, detail?: string) => {
    setLogs((prev) => [...prev, makeLogEntry(level, message, detail)]);
  }, []);

  const [step, setStep] = useState<Step>("seed");
  const [seed, setSeed] = useState<Uint8Array | null>(null);
  const [seedHex, setSeedHex] = useState("");
  const [backedUp, setBackedUp] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [recoverHex, setRecoverHex] = useState("");
  const [tokenIndex, setTokenIndex] = useState(0);
  const [token, setToken] = useState<TokenSecrets | null>(null);
  const [vaultCfg, setVaultCfg] = useState<VaultCfg | null>(null);
  const [freighter, setFreighter] = useState<string | null>(null);
  const [depositHash, setDepositHash] = useState<string | null>(null);
  const [announceTx, setAnnounceTx] = useState<string | null>(null);
  const [unblindedSHex, setUnblindedSHex] = useState<string | null>(null);
  const [recipient, setRecipient] = useState(cfg.recipientPreset);
  const [redeemHash, setRedeemHash] = useState<string | null>(null);
  const [relayerPk, setRelayerPk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [eventCursor, setEventCursor] = useState(0);

  useEffect(() => {
    log("info", "Loading vault config()…");
    fetch("/api/vault?op=config")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "config failed");
        setVaultCfg(j);
        log("ok", "Vault config loaded", `denomination=${j.denomination} mint=${j.mintAuthority}`);
      })
      .catch((e) => log("error", "Vault config failed", String(e)));
  }, [log]);

  const onGenerate = () => {
    const s = generateTokenSeed();
    setSeed(s);
    setSeedHex(seedToHex(s));
    setBackedUp(false);
    setToken(secretsAt(s, tokenIndex));
    log("ok", "Token Seed generated in-browser", "Never transmitted to Sponsor/Relayer");
  };

  const onRecover = () => {
    try {
      const s = seedFromHex(recoverHex);
      setSeed(s);
      setSeedHex(seedToHex(s));
      setBackedUp(true);
      setToken(secretsAt(s, tokenIndex));
      log("ok", "Seed Recovery applied", `index=${tokenIndex}`);
    } catch (e) {
      log("error", "Seed Recovery failed", String(e));
    }
  };

  const onCacheSave = async () => {
    if (!seed) return;
    try {
      await saveSeedCache(seed, passphrase);
      log("ok", "Local Seed Cache written (AES-GCM)");
    } catch (e) {
      log("error", "Cache save failed", String(e));
    }
  };

  const onCacheLoad = async () => {
    try {
      const s = await loadSeedCache(passphrase);
      if (!s) {
        log("warn", "No Local Seed Cache present");
        return;
      }
      setSeed(s);
      setSeedHex(seedToHex(s));
      setBackedUp(true);
      setToken(secretsAt(s, tokenIndex));
      log("ok", "Local Seed Cache unlocked");
    } catch (e) {
      log("error", "Cache unlock failed", String(e));
    }
  };

  useEffect(() => {
    if (seed) setToken(secretsAt(seed, tokenIndex));
  }, [seed, tokenIndex]);

  // Pending Announce poll
  useEffect(() => {
    if (step !== "pending" || !token || !vaultCfg) return;
    let cancelled = false;
    let cursor = eventCursor;

    const tick = async () => {
      try {
        log("info", "Polling announce events…", `startLedger=${cursor}`);
        const res = await fetch(`/api/vault?op=announce&start=${cursor}`);
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? "announce poll failed");
        cursor = j.nextLedger as number;
        if (!cancelled) setEventCursor(cursor);
        log("info", "Announce page scanned", `nextLedger=${cursor} events=${j.events.length}`);

        for (const ev of j.events as { keyHex: string; dataHex: string | null; txHash: string }[]) {
          const key = fromHex(ev.keyHex);
          if (!equalBytes(key, token.depositId)) continue;
          if (!ev.dataHex) continue;
          log("ok", "Announce matched deposit_id", ev.txHash);
          const { unblindedSHex: sHex, ok } = unblindAndVerify({
            sPrimeBytes: fromHex(ev.dataHex),
            token,
            mintPkHex: vaultCfg.mintPkHex,
          });
          if (!ok) {
            log("error", "Local pairing verify failed — mint signed garbage?");
            continue;
          }
          log("ok", "Unblinded + verified blind signature locally");
          if (cancelled) return;
          setAnnounceTx(ev.txHash);
          setUnblindedSHex(sHex);
          setStep("ready");
          return;
        }

        const st = await fetch(
          `/api/vault?op=status&depositId=${toHex(token.depositId)}`,
        ).then((r) => r.json());
        log("info", `deposit_status=${st.status}`);
        if (st.status === "Refunded" && !cancelled) {
          setStep("refunded");
        }
      } catch (e) {
        log("warn", "Poll tick error", String(e));
      }
    };

    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cursor advanced internally while pending
  }, [step, token, vaultCfg, log]);

  const onConnect = async () => {
    setBusy(true);
    try {
      log("info", "Requesting Freighter access…");
      const addr = await connectFreighter();
      setFreighter(addr);
      log("ok", "Freighter connected", addr);
    } catch (e) {
      log("error", "Freighter connect failed", String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDeposit = async () => {
    if (!token || !freighter || !backedUp) return;
    setBusy(true);
    try {
      log("info", "Preparing deposit invoke for Freighter…");
      const blind = prepareDepositBlind(token);
      log("info", "Blinded nullifier → B", `depositId=${blind.depositIdHex.slice(0, 16)}…`);
      const prepRes = await fetch("/api/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          method: "deposit",
          sourcePublicKey: freighter,
          depositIdHex: blind.depositIdHex,
          blindedBHex: blind.blindedBHex,
        }),
      });
      const prepared = await prepRes.json();
      if (!prepRes.ok) throw new Error(prepared.error ?? "prepare failed");
      log("info", "Freighter prompt — sign deposit (public / screened half)");
      const hash = await freighterSignAndSubmit(prepared.xdr);
      setDepositHash(hash);
      const ledgerRes = await fetch("/api/vault?op=ledger").then((r) => r.json());
      setEventCursor(Math.max(0, (ledgerRes.latestLedger as number) - 5));
      log("ok", "Deposit submitted", hash);
      log("info", "Entering Pending Announce — Off-App Mint must announce");
      setStep("pending");
    } catch (e) {
      log("error", "Deposit failed", String(e));
    } finally {
      setBusy(false);
    }
  };

  const onRefund = async () => {
    if (!token || !freighter) return;
    setBusy(true);
    try {
      log("info", "Preparing First-Class Refund…");
      const prepRes = await fetch("/api/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          method: "refund",
          sourcePublicKey: freighter,
          depositIdHex: toHex(token.depositId),
        }),
      });
      const prepared = await prepRes.json();
      if (!prepRes.ok) throw new Error(prepared.error ?? "prepare failed");
      const hash = await freighterSignAndSubmit(prepared.xdr);
      log("ok", "Refund submitted", hash);
      setStep("refunded");
    } catch (e) {
      log("error", "Refund failed", String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSponsor = async () => {
    setBusy(true);
    try {
      log("info", "Calling Demo Sponsor (no deposit_id)…");
      const res = await fetch("/api/sponsor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ depositorPublicKey: freighter }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "sponsor failed");
      setRecipient(j.publicKey);
      log("ok", "Sponsored Recipient created", j.publicKey);
    } catch (e) {
      log("error", "Sponsor failed", String(e));
    } finally {
      setBusy(false);
    }
  };

  const onRedeem = async () => {
    if (!token || !unblindedSHex) return;
    setBusy(true);
    try {
      log("warn", "Timing Caution acknowledged — redeeming now shrinks anonymity set by clock");
      const payload = packageRedeem({
        token,
        recipient,
        unblindedSHex,
      });
      log("info", "Handing redeem to Demo Relayer (not Freighter)", `recipient=${recipient}`);
      const res = await fetch("/api/relayer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "relayer failed");
      setRedeemHash(j.hash);
      setRelayerPk(j.relayerPublicKey);
      log("ok", "Redeem landed", j.hash);
      setStep("proof");
    } catch (e) {
      log("error", "Redeem failed", String(e));
    } finally {
      setBusy(false);
    }
  };

  const denomLabel = vaultCfg
    ? `${stroopsToXlm(vaultCfg.denomination)} XLM (fixed)`
    : "…";

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-5 py-10 md:px-8 md:py-14">
      <header className="max-w-3xl">
        <p className="font-[family-name:var(--font-mono)] text-xs tracking-[0.22em] text-[var(--accent)] uppercase">
          Stellar testnet
        </p>
        <h1 className="mt-3 text-5xl font-extrabold tracking-tight text-[var(--ink)] md:text-7xl">
          Shinobi
        </h1>
        <p className="mt-4 max-w-xl text-lg text-[var(--ink-muted)] md:text-xl">
          Compliant Privacy Pool for institutional payroll — one Shielded Transfer
          at a time.
        </p>
      </header>

      <div className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr]">
        <section className="space-y-6">
          {/* Seed */}
          <Panel title="1 · Token Seed" active={step === "seed"}>
            <p className="text-sm text-[var(--ink-muted)]">
              The browser is the wallet. A lost seed after deposit locks funds forever —
              Backup Gate before deposit goes live.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Btn onClick={onGenerate} disabled={busy}>
                Generate seed
              </Btn>
              <Btn
                tone="ghost"
                onClick={() => {
                  clearSeedCache();
                  log("info", "Local Seed Cache cleared");
                }}
              >
                Clear cache
              </Btn>
            </div>
            {seedHex ? (
              <div className="mt-4 space-y-3">
                <MonoBlock label="Token Seed (hex)">{seedHex}</MonoBlock>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={backedUp}
                    onChange={(e) => setBackedUp(e.target.checked)}
                    className="mt-1"
                  />
                  <span>
                    I saved this Token Seed offline. Enable deposit (Backup Gate).
                  </span>
                </label>
                <div className="flex flex-wrap items-end gap-2">
                  <input
                    type="password"
                    placeholder="Cache passphrase"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    className="min-w-[12rem] flex-1 rounded border border-[var(--line)] bg-white/70 px-3 py-2 font-[family-name:var(--font-mono)] text-sm"
                  />
                  <Btn tone="ghost" onClick={onCacheSave} disabled={!passphrase || !seed}>
                    Save cache
                  </Btn>
                  <Btn tone="ghost" onClick={onCacheLoad} disabled={!passphrase || !hasSeedCache()}>
                    Unlock cache
                  </Btn>
                </div>
              </div>
            ) : null}
            <div className="mt-4 space-y-2">
              <p className="text-xs uppercase tracking-wide text-[var(--ink-muted)]">
                Seed Recovery
              </p>
              <textarea
                value={recoverHex}
                onChange={(e) => setRecoverHex(e.target.value)}
                rows={2}
                placeholder="Paste 64 hex chars"
                className="w-full rounded border border-[var(--line)] bg-white/70 px-3 py-2 font-[family-name:var(--font-mono)] text-xs"
              />
              <Btn tone="ghost" onClick={onRecover}>
                Recover from seed
              </Btn>
            </div>
          </Panel>

          {/* Deposit */}
          <Panel title="2 · Freighter Deposit" active={step === "deposit" || (step === "seed" && backedUp)}>
            <p className="text-sm text-[var(--ink-muted)]">
              Denomination <strong>{denomLabel}</strong>. Your address is screened by the
              Off-App Mint. If declined, use First-Class Refund.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Btn onClick={onConnect} disabled={busy}>
                {freighter ? "Freighter connected" : "Connect Freighter"}
              </Btn>
              <Btn
                onClick={onDeposit}
                disabled={busy || !backedUp || !freighter || !token || step === "pending" || step === "ready" || step === "proof"}
              >
                Deposit
              </Btn>
            </div>
            {freighter ? (
              <MonoBlock label="Depositor">{freighter}</MonoBlock>
            ) : (
              <p className="mt-2 font-[family-name:var(--font-mono)] text-xs text-[var(--ink-muted)]">
                Hint fixture: {cfg.depositorHint}
              </p>
            )}
            {depositHash ? (
              <MonoBlock label="Deposit tx">
                <a
                  className="underline"
                  href={`${cfg.expertBase}/tx/${depositHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {depositHash}
                </a>
              </MonoBlock>
            ) : null}
          </Panel>

          {/* Pending */}
          <Panel
            title="3 · Pending Announce"
            active={step === "pending"}
            pulse={step === "pending"}
          >
            <p className="text-sm text-[var(--ink-muted)]">
              Waiting for Off-App Mint to announce. Open-ended — Activity Pulse means the
              app is alive.
            </p>
            <div className="mt-3">
              <Btn tone="danger" onClick={onRefund} disabled={busy || step !== "pending" || !freighter}>
                First-Class Refund
              </Btn>
            </div>
          </Panel>

          {/* Redeem */}
          <Panel title="4 · Redeem via Relayer" active={step === "ready"}>
            <p className="text-sm text-[var(--ink-muted)]">
              <strong>Timing Caution:</strong> redeeming soon after deposit weakens
              unlinkability by timing. No forced delay — your call for the pitch.
            </p>
            <label className="mt-3 block text-xs uppercase tracking-wide text-[var(--ink-muted)]">
              Recipient Address
            </label>
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              className="mt-1 w-full rounded border border-[var(--line)] bg-white/70 px-3 py-2 font-[family-name:var(--font-mono)] text-sm"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <Btn
                tone="ghost"
                onClick={() => setRecipient(cfg.recipientPreset)}
                disabled={busy}
              >
                Demo Recipient Preset
              </Btn>
              <Btn tone="ghost" onClick={onSponsor} disabled={busy}>
                Create Sponsored Recipient
              </Btn>
              <Btn onClick={onRedeem} disabled={busy || step !== "ready" || !unblindedSHex}>
                Redeem (relayer)
              </Btn>
            </div>
          </Panel>

          {/* Proof */}
          {step === "proof" && redeemHash ? (
            <Panel title="Unlinkability Proof" active>
              <ol className="mt-2 list-decimal space-y-3 pl-5 text-sm">
                <li>
                  Recipient history should show vault payment — not the depositor.{" "}
                  <a
                    className="text-[var(--accent)] underline"
                    href={`${cfg.expertBase}/account/${recipient}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Expert · recipient
                  </a>
                </li>
                <li>
                  Redeem fee payer is the Demo Relayer
                  {relayerPk ? ` (${relayerPk.slice(0, 4)}…${relayerPk.slice(-4)})` : ""}.{" "}
                  <a
                    className="text-[var(--accent)] underline"
                    href={`${cfg.expertBase}/tx/${redeemHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Expert · redeem tx
                  </a>
                </li>
                <li>
                  Nullifier spent / deposit finished.{" "}
                  {depositHash ? (
                    <a
                      className="text-[var(--accent)] underline"
                      href={`${cfg.expertBase}/tx/${depositHash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Expert · deposit tx
                    </a>
                  ) : null}
                  {announceTx ? (
                    <>
                      {" · "}
                      <a
                        className="text-[var(--accent)] underline"
                        href={`${cfg.expertBase}/tx/${announceTx}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        announce
                      </a>
                    </>
                  ) : null}
                </li>
              </ol>
            </Panel>
          ) : null}

          {step === "refunded" ? (
            <Panel title="Refunded" active>
              <p className="text-sm">Funds returned to depositor. Mint refusal is by design.</p>
            </Panel>
          ) : null}
        </section>

        <aside className="lg:sticky lg:top-8 lg:self-start">
          <div className="rounded-2xl border border-[var(--line)] bg-white/55 p-4 shadow-[0_20px_60px_-40px_rgba(16,24,32,0.45)] backdrop-blur">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold tracking-wide uppercase">
                Verbose Demo Log
              </h2>
              {step === "pending" ? (
                <span className="activity-pulse inline-flex h-3 w-3 rounded-full bg-[var(--accent)]" />
              ) : null}
            </div>
            <div className="mt-3 max-h-[70vh] space-y-2 overflow-y-auto font-[family-name:var(--font-mono)] text-[11px] leading-relaxed">
              {logs.length === 0 ? (
                <p className="text-[var(--ink-muted)]">Waiting for activity…</p>
              ) : (
                logs.map((entry) => (
                  <div key={entry.id} className="border-b border-[var(--line)]/60 pb-2">
                    <div className="flex gap-2">
                      <span
                        className={
                          entry.level === "ok"
                            ? "text-[var(--ok)]"
                            : entry.level === "warn"
                              ? "text-[var(--warn)]"
                              : entry.level === "error"
                                ? "text-[var(--err)]"
                                : "text-[var(--ink-muted)]"
                        }
                      >
                        {entry.level.toUpperCase()}
                      </span>
                      <span className="text-[var(--ink-muted)]">
                        {entry.at.slice(11, 19)}
                      </span>
                    </div>
                    <div>{entry.message}</div>
                    {entry.detail ? (
                      <div className="break-all text-[var(--ink-muted)]">{entry.detail}</div>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Panel({
  title,
  children,
  active,
  pulse,
}: {
  title: string;
  children: React.ReactNode;
  active?: boolean;
  pulse?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border p-5 transition ${
        active
          ? "border-[var(--accent)] bg-white/70 shadow-[0_24px_50px_-36px_rgba(11,110,79,0.55)]"
          : "border-[var(--line)] bg-white/40"
      }`}
    >
      <div className="flex items-center gap-3">
        {pulse ? (
          <span className="activity-pulse inline-flex h-3 w-3 rounded-full bg-[var(--accent)]" />
        ) : null}
        <h2 className="text-lg font-semibold">{title}</h2>
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Btn({
  children,
  onClick,
  disabled,
  tone = "primary",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "primary" | "ghost" | "danger";
}) {
  const styles =
    tone === "ghost"
      ? "border border-[var(--line)] bg-white/60 text-[var(--ink)]"
      : tone === "danger"
        ? "bg-[var(--err)] text-white"
        : "bg-[var(--accent)] text-white hover:bg-[var(--accent-deep)]";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-40 ${styles}`}
    >
      {children}
    </button>
  );
}

function MonoBlock({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3">
      <div className="text-[10px] tracking-wide text-[var(--ink-muted)] uppercase">
        {label}
      </div>
      <div className="mt-1 break-all font-[family-name:var(--font-mono)] text-xs">
        {children}
      </div>
    </div>
  );
}
