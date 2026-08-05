"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { CosmosBackdrop } from "@/components/cosmos-backdrop";

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

const PAYROLL_STEPS = [
  { id: "seed", label: "Save recovery key" },
  { id: "deposit", label: "Connect & deposit" },
  { id: "pending", label: "Compliance check" },
  { id: "ready", label: "Pay employee" },
  { id: "proof", label: "Show proof" },
] as const;

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

function truncateMid(value: string, head = 8, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function stepIndex(step: Step): number {
  if (step === "refunded") return 2;
  const i = PAYROLL_STEPS.findIndex((s) => s.id === step);
  return i >= 0 ? i : 0;
}

export function DepositorFlow() {
  const cfg = useMemo(() => publicConfig(), []);
  const [logs, setLogs] = useState<DemoLogEntry[]>([]);
  const log = useCallback((level: DemoLogEntry["level"], message: string, detail?: string) => {
    setLogs((prev) => [...prev, makeLogEntry(level, message, detail)]);
  }, []);

  const logsRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const [step, setStep] = useState<Step>("seed");
  const [seed, setSeed] = useState<Uint8Array | null>(null);
  const [seedHex, setSeedHex] = useState("");
  const [showFullKey, setShowFullKey] = useState(false);
  const [backedUp, setBackedUp] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [recoverHex, setRecoverHex] = useState("");
  const [showRecover, setShowRecover] = useState(false);
  const [tokenIndex] = useState(0);
  const [token, setToken] = useState<TokenSecrets | null>(null);
  const [vaultCfg, setVaultCfg] = useState<VaultCfg | null>(null);
  const [freighter, setFreighter] = useState<string | null>(null);
  const [depositHash, setDepositHash] = useState<string | null>(null);
  const [announceTx, setAnnounceTx] = useState<string | null>(null);
  const [unblindedSHex, setUnblindedSHex] = useState<string | null>(null);
  const [recipient, setRecipient] = useState(cfg.recipientPreset);
  const [redeemHash, setRedeemHash] = useState<string | null>(null);
  const [refundHash, setRefundHash] = useState<string | null>(null);
  const [relayerPk, setRelayerPk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [eventCursor, setEventCursor] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!stickToBottom.current || !logsRef.current) return;
    logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [logs]);

  const onLogsScroll = () => {
    const el = logsRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = dist < 48;
  };

  useEffect(() => {
    log("info", "Connecting to the payroll pool…", "Reading vault config()");
    fetch("/api/vault?op=config")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "config failed");
        setVaultCfg(j);
        log(
          "ok",
          "Pool ready — fixed deposit amount locked in",
          `denomination=${j.denomination} mint=${j.mintAuthority}`,
        );
      })
      .catch((e) => log("error", "Could not reach the pool", String(e)));
  }, [log]);

  const onGenerate = () => {
    const s = generateTokenSeed();
    const hex = seedToHex(s);
    setSeed(s);
    setSeedHex(hex);
    setBackedUp(false);
    setShowFullKey(false);
    setToken(secretsAt(s, tokenIndex));
    log(
      "ok",
      "Recovery key created in this browser only",
      `full key=${hex} — never sent to compliance or the pay relay`,
    );
  };

  const onCopyKey = async () => {
    if (!seedHex) return;
    await navigator.clipboard.writeText(seedHex);
    setCopied(true);
    log("info", "Recovery key copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  const onRecover = () => {
    try {
      const s = seedFromHex(recoverHex);
      setSeed(s);
      setSeedHex(seedToHex(s));
      setBackedUp(true);
      setToken(secretsAt(s, tokenIndex));
      log("ok", "Recovery key restored — rebuilding payroll session", `index=${tokenIndex}`);
      setStep("deposit");
    } catch (e) {
      log("error", "Recovery key could not be read", String(e));
    }
  };

  const onCacheSave = async () => {
    if (!seed) return;
    try {
      await saveSeedCache(seed, passphrase);
      log("ok", "Encrypted recovery cache saved on this device");
    } catch (e) {
      log("error", "Could not save recovery cache", String(e));
    }
  };

  const onCacheLoad = async () => {
    try {
      const s = await loadSeedCache(passphrase);
      if (!s) {
        log("warn", "No recovery cache on this device");
        return;
      }
      setSeed(s);
      setSeedHex(seedToHex(s));
      setBackedUp(true);
      setToken(secretsAt(s, tokenIndex));
      log("ok", "Recovery cache unlocked");
    } catch (e) {
      log("error", "Wrong passphrase or corrupt cache", String(e));
    }
  };

  useEffect(() => {
    if (seed) setToken(secretsAt(seed, tokenIndex));
  }, [seed, tokenIndex]);

  // Compliance check poll → auto-advance to Pay employee
  useEffect(() => {
    if (step !== "pending" || !token || !vaultCfg) return;
    let cancelled = false;
    let cursor = eventCursor;

    const tick = async () => {
      try {
        log("info", "Waiting on compliance…", `scanning ledgers from ${cursor}`);
        const res = await fetch(`/api/vault?op=announce&start=${cursor}`);
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? "announce poll failed");
        cursor = j.nextLedger as number;
        if (!cancelled) setEventCursor(cursor);

        for (const ev of j.events as {
          keyHex: string;
          dataHex: string | null;
          txHash: string;
        }[]) {
          const key = fromHex(ev.keyHex);
          if (!equalBytes(key, token.depositId)) continue;
          if (!ev.dataHex) continue;
          log(
            "ok",
            "Compliance approved — unblinding the pay token",
            `announce tx=${ev.txHash}`,
          );
          const { unblindedSHex: sHex, ok } = unblindAndVerify({
            sPrimeBytes: fromHex(ev.dataHex),
            token,
            mintPkHex: vaultCfg.mintPkHex,
          });
          if (!ok) {
            log("error", "Blind signature check failed — not safe to pay out");
            continue;
          }
          log(
            "ok",
            "Blind signature verified locally — deposit and payout stay unlinkable",
            `S verified against mint_pk`,
          );
          if (cancelled) return;
          setAnnounceTx(ev.txHash);
          setUnblindedSHex(sHex);
          setStep("ready");
          return;
        }

        const st = await fetch(
          `/api/vault?op=status&depositId=${toHex(token.depositId)}`,
        ).then((r) => r.json());
        log(
          "info",
          "Compliance still in progress — Off-App Mint must be running",
          `deposit_status=${st.status}`,
        );
        if (st.status === "Refunded" && !cancelled) {
          setStep("refunded");
        }
      } catch (e) {
        log("warn", "Compliance poll hiccup — retrying", String(e));
      }
    };

    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, token, vaultCfg, log]);

  const onConnect = async () => {
    setBusy(true);
    try {
      log("info", "Opening company wallet (Freighter)…");
      const addr = await connectFreighter();
      setFreighter(addr);
      log("ok", "Company wallet connected", addr);
    } catch (e) {
      log("error", "Wallet connection failed", String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDeposit = async () => {
    if (!token || !freighter || !backedUp) return;
    setBusy(true);
    try {
      const blind = prepareDepositBlind(token);
      log(
        "info",
        "Blinding this deposit so the later payout can’t be linked on-chain",
        `deposit_id=${blind.depositIdHex}`,
      );
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
      log("info", "Sign the deposit in your wallet — this half is public and screened");
      const hash = await freighterSignAndSubmit(prepared.xdr);
      setDepositHash(hash);
      const ledgerRes = await fetch("/api/vault?op=ledger").then((r) => r.json());
      setEventCursor(Math.max(0, (ledgerRes.latestLedger as number) - 5));
      log("ok", "Payroll deposit submitted", hash);
      log("info", "Handing off to compliance — they never see who you’ll pay");
      setStep("pending");
    } catch (e) {
      log("error", "Deposit failed", String(e));
    } finally {
      setBusy(false);
    }
  };

  const onComplianceTick = async () => {
    if (!token) return;
    setBusy(true);
    try {
      log("info", "Running demo compliance tick (one-shot announce)…");
      const res = await fetch("/api/mint/tick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          depositIdHex: toHex(token.depositId),
          startLedger: Math.max(0, eventCursor - 50),
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "compliance tick failed");
      if (j.decision === "already") {
        log("ok", "Already approved on-chain — waiting for Logs to catch announce");
      } else {
        log(
          "ok",
          "Compliance approved via demo tick — blind signature published",
          j.announceTx
            ? `${cfg.expertBase}/tx/${j.announceTx}`
            : `depositor=${j.depositor}`,
        );
      }
    } catch (e) {
      log("error", "Compliance tick failed", String(e));
    } finally {
      setBusy(false);
    }
  };

  const onRefund = async () => {
    if (!token || !freighter) return;
    setBusy(true);
    try {
      log("info", "Canceling — reclaiming deposit back to the company wallet");
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
      setRefundHash(hash);
      log(
        "ok",
        "Deposit reclaimed",
        `${cfg.expertBase}/tx/${hash}`,
      );
      setStep("refunded");
    } catch (e) {
      log("error", "Reclaim failed", String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSponsor = async () => {
    setBusy(true);
    try {
      log("info", "Creating a fresh employee address (shared sponsor — not the company wallet)");
      const res = await fetch("/api/sponsor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ depositorPublicKey: freighter }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "sponsor failed");
      setRecipient(j.publicKey);
      log("ok", "New private employee address ready", j.publicKey);
    } catch (e) {
      log("error", "Could not create employee address", String(e));
    } finally {
      setBusy(false);
    }
  };

  const onRedeem = async () => {
    if (!token || !unblindedSHex) return;
    setBusy(true);
    try {
      log(
        "warn",
        "Paying immediately after deposit makes timing easier to guess — fine for a live demo",
      );
      const payload = packageRedeem({
        token,
        recipient,
        unblindedSHex,
      });
      log(
        "info",
        "Sending payout through the relay — your company wallet does not submit this tx",
        `employee=${recipient}`,
      );
      const res = await fetch("/api/relayer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "relayer failed");
      setRedeemHash(j.hash);
      setRelayerPk(j.relayerPublicKey);
      log("ok", "Employee paid — on-chain link broken", j.hash);
      setStep("proof");
    } catch (e) {
      log("error", "Payout failed", String(e));
    } finally {
      setBusy(false);
    }
  };

  const denomLabel = vaultCfg
    ? `${stroopsToXlm(vaultCfg.denomination)} XLM`
    : "…";
  const activeIdx = stepIndex(step);
  const cosmosActive =
    step === "deposit" || step === "pending" || step === "ready";

  return (
    <>
      <CosmosBackdrop active={cosmosActive} />
    <div className="relative z-0 mx-auto flex w-full max-w-6xl flex-col gap-5 px-5 py-6 md:px-8 md:py-8">
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,0.92fr)_minmax(300px,0.78fr)]">
        <div className="min-w-0 space-y-5">
          <header className="max-w-xl">
            <p className="font-[family-name:var(--font-mono)] text-xs tracking-[0.18em] text-[var(--accent)] uppercase">
              Blind Signature * Testnet
            </p>
            <h1 className="mt-2 text-4xl font-extrabold tracking-tight md:text-5xl">Shinobi</h1>
            <p className="mt-2 text-base leading-snug text-[var(--ink-muted)] md:text-lg">
              Compliant Privacy Pool for institutional payroll
              <br />
              Pay an employee without publishing who got paid.
            </p>
          </header>

          <ProgressRail activeIdx={activeIdx} step={step} />

          <section>
          {step === "seed" && (
            <WizardCard
              title="Save recovery key"
              subtitle={
                <>
                  If you lose this key after depositing, the payroll funds stay locked.
                  <br />
                  Save it before you continue.
                </>
              }
            >
              <div className="flex flex-wrap gap-2">
                <Btn onClick={onGenerate} disabled={busy}>
                  Create recovery key
                </Btn>
                <Btn
                  tone="ghost"
                  onClick={() => {
                    clearSeedCache();
                    log("info", "Cleared encrypted recovery cache on this device");
                  }}
                >
                  Clear device cache
                </Btn>
              </div>

              {seedHex ? (
                <div className="mt-5 space-y-4">
                  <div className="rounded-xl border border-[var(--line)] bg-black/25 p-4">
                    <div className="text-[10px] tracking-wide text-[var(--ink-muted)] uppercase">
                      Recovery key
                    </div>
                    <div className="mt-2 break-all font-[family-name:var(--font-mono)] text-sm">
                      {showFullKey ? seedHex : truncateMid(seedHex, 10, 8)}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Btn tone="ghost" onClick={onCopyKey}>
                        {copied ? "Copied" : "Copy"}
                      </Btn>
                      <Btn tone="ghost" onClick={() => setShowFullKey((v) => !v)}>
                        {showFullKey ? "Hide" : "Show full key"}
                      </Btn>
                    </div>
                  </div>
                  <label className="flex items-start gap-3 text-sm">
                    <input
                      type="checkbox"
                      checked={backedUp}
                      onChange={(e) => {
                        setBackedUp(e.target.checked);
                        if (e.target.checked) {
                          log("ok", "Recovery key backup confirmed — deposit unlocked");
                          setStep("deposit");
                        }
                      }}
                      className="mt-1"
                    />
                    <span>I saved this recovery key offline. Continue to deposit.</span>
                  </label>
                  <details className="text-sm text-[var(--ink-muted)]">
                    <summary className="cursor-pointer">Optional device cache</summary>
                    <div className="mt-3 flex flex-wrap items-end gap-2">
                      <input
                        type="password"
                        placeholder="Passphrase"
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                        className="min-w-[12rem] flex-1 rounded-lg border border-[var(--line)] bg-black/30 px-3 py-2 font-[family-name:var(--font-mono)] text-sm"
                      />
                      <Btn tone="ghost" onClick={onCacheSave} disabled={!passphrase || !seed}>
                        Save cache
                      </Btn>
                      <Btn
                        tone="ghost"
                        onClick={onCacheLoad}
                        disabled={!passphrase || !hasSeedCache()}
                      >
                        Unlock cache
                      </Btn>
                    </div>
                  </details>
                </div>
              ) : null}

              <button
                type="button"
                className="mt-4 text-xs text-[var(--ink-muted)] underline"
                onClick={() => setShowRecover((v) => !v)}
              >
                {showRecover ? "Hide restore" : "Already have a key? Restore"}
              </button>
              {showRecover ? (
                <div className="mt-3 space-y-2">
                  <textarea
                    value={recoverHex}
                    onChange={(e) => setRecoverHex(e.target.value)}
                    rows={2}
                    placeholder="Paste recovery key"
                    className="w-full rounded-lg border border-[var(--line)] bg-black/30 px-3 py-2 font-[family-name:var(--font-mono)] text-xs"
                  />
                  <Btn tone="ghost" onClick={onRecover}>
                    Restore & continue
                  </Btn>
                </div>
              ) : null}
            </WizardCard>
          )}

          {step === "deposit" && (
            <WizardCard
              title="Connect & deposit"
              subtitle={
                <>
                  Deposit {denomLabel} from the company wallet into the privacy pool.
                  <br />
                  Compliance screens this deposit; the employee pay-out stays unlinkable.
                </>
              }
            >
              <div className="flex flex-wrap gap-2">
                <Btn onClick={onConnect} disabled={busy}>
                  {freighter ? "Wallet connected" : "Connect company wallet"}
                </Btn>
                <Btn onClick={onDeposit} disabled={busy || !freighter || !token || !backedUp}>
                  Deposit payroll
                </Btn>
              </div>
              {freighter ? (
                <Mono label="Company wallet">{truncateMid(freighter, 6, 6)}</Mono>
              ) : (
                <p className="mt-3 text-xs text-[var(--ink-muted)]">
                  Use Freighter on testnet. Fixture hint: {truncateMid(cfg.depositorHint, 6, 6)}
                </p>
              )}
              {depositHash ? (
                <Mono label="Deposit">
                  <a
                    className="underline decoration-[var(--accent)]/50"
                    href={`${cfg.expertBase}/tx/${depositHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {truncateMid(depositHash, 10, 8)}
                  </a>
                </Mono>
              ) : null}
              <button
                type="button"
                className="mt-4 text-xs text-[var(--ink-muted)] underline"
                onClick={() => setStep("seed")}
              >
                Back to recovery key
              </button>
            </WizardCard>
          )}

          {step === "pending" && (
            <WizardCard
              title="Compliance check"
              subtitle={
                <>
                  The compliance service reviews the company deposit, then issues a blind approval.
                  <br />
                  You never tell them who the employee is.
                </>
              }
              pulse
            >
              <p className="text-sm text-[var(--ink-muted)]">
                Waiting on-chain, or run compliance here for a local/Vercel demo (no separate mint
                process).
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Btn onClick={onComplianceTick} disabled={busy || !token}>
                  Run compliance
                </Btn>
                <Btn tone="danger" onClick={onRefund} disabled={busy || !freighter}>
                  Cancel & reclaim
                </Btn>
              </div>
            </WizardCard>
          )}

          {step === "ready" && (
            <WizardCard
              title="Pay employee"
              subtitle={
                <>
                  Choose where payroll lands. The payout is submitted by a relay, not your company wallet.
                  <br />
                  That way the fee payer doesn’t re-link the payment.
                </>
              }
            >
              <label className="text-[10px] tracking-wide text-[var(--ink-muted)] uppercase">
                Employee payout address
              </label>
              <input
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                className="mt-1 w-full rounded-lg border border-[var(--line)] bg-black/30 px-3 py-2.5 font-[family-name:var(--font-mono)] text-sm"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <Btn
                  tone="ghost"
                  onClick={() => setRecipient(cfg.recipientPreset)}
                  disabled={busy}
                >
                  Use demo employee
                </Btn>
                <Btn tone="ghost" onClick={onSponsor} disabled={busy}>
                  New private address
                </Btn>
                <Btn onClick={onRedeem} disabled={busy || !unblindedSHex}>
                  Pay employee
                </Btn>
              </div>
            </WizardCard>
          )}

          {step === "proof" && redeemHash ? (
            <WizardCard
              title="Show proof"
              subtitle={
                <>
                  Three facts a treasury lead can open on Explorer.
                  <br />
                  This is the mic-drop for the pitch.
                </>
              }
            >
              <ol className="list-decimal space-y-4 pl-5 text-sm leading-relaxed">
                <li>
                  The employee account history shows the pool payout — not the company wallet.{" "}
                  <a
                    className="text-[var(--accent)] underline"
                    href={`${cfg.expertBase}/account/${recipient}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open employee
                  </a>
                </li>
                <li>
                  The payout fee was paid by the relay
                  {relayerPk ? ` (${truncateMid(relayerPk, 4, 4)})` : ""}, not the company.{" "}
                  <a
                    className="text-[var(--accent)] underline"
                    href={`${cfg.expertBase}/tx/${redeemHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open payout tx
                  </a>
                </li>
                <li>
                  The private pay token is spent; deposit finished.{" "}
                  {depositHash ? (
                    <a
                      className="text-[var(--accent)] underline"
                      href={`${cfg.expertBase}/tx/${depositHash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Deposit
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
                        Compliance
                      </a>
                    </>
                  ) : null}
                </li>
              </ol>
            </WizardCard>
          ) : null}

          {step === "refunded" ? (
            <WizardCard
              title="Deposit reclaimed"
              subtitle={
                <>
                  Compliance declined or you canceled.
                  <br />
                  Funds returned to the company wallet, not seized.
                </>
              }
            >
              {refundHash ? (
                <Mono label="Reclaim tx">
                  <a
                    className="underline decoration-[var(--accent)]/50"
                    href={`${cfg.expertBase}/tx/${refundHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {truncateMid(refundHash, 10, 8)}
                  </a>
                </Mono>
              ) : null}
              <div className="mt-4">
                <Btn tone="ghost" onClick={() => setStep("seed")}>
                  Start another payroll
                </Btn>
              </div>
            </WizardCard>
          ) : null}
          </section>
        </div>

        <aside className="min-w-0 lg:sticky lg:top-6 lg:self-start">
          <div className="flex max-h-[calc(100vh-3rem)] flex-col rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4 backdrop-blur-md">
            <div className="flex shrink-0 items-center justify-between gap-2">
              <h2 className="text-sm font-semibold tracking-wide uppercase">Logs</h2>
              {step === "pending" ? (
                <span className="activity-pulse inline-flex h-2.5 w-2.5 rounded-full bg-[var(--accent)]" />
              ) : null}
            </div>
            <div
              ref={logsRef}
              onScroll={onLogsScroll}
              className="mt-3 min-h-0 flex-1 space-y-2.5 overflow-y-auto font-[family-name:var(--font-mono)] text-[11px] leading-relaxed"
            >
              {logs.length === 0 ? (
                <p className="text-[var(--ink-muted)]">Waiting…</p>
              ) : (
                logs.map((entry) => (
                  <div key={entry.id} className="border-b border-[var(--line)]/80 pb-2.5">
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
                      <span className="text-[var(--ink-muted)]">{entry.at.slice(11, 19)}</span>
                    </div>
                    <div className="mt-0.5 text-[12px] text-[var(--ink)]">{entry.message}</div>
                    {entry.detail ? (
                      <div className="mt-0.5 break-all text-[var(--ink-muted)]">{entry.detail}</div>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
    </>
  );
}

function ProgressRail({ activeIdx, step }: { activeIdx: number; step: Step }) {
  return (
    <nav aria-label="Payroll steps" className="overflow-x-auto">
      <ol className="flex min-w-max gap-1 md:gap-2">
        {PAYROLL_STEPS.map((s, i) => {
          const active =
            step === "refunded" ? i === 2 : step === "proof" ? i === 4 : i === activeIdx;
          const done =
            step === "proof" ? i < 4 : step === "refunded" ? false : i < activeIdx;
          return (
            <li
              key={s.id}
              className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs md:text-sm ${
                active
                  ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--ink)]"
                  : done
                    ? "border-[var(--line)] text-[var(--accent)]"
                    : "border-transparent text-[var(--ink-muted)]"
              }`}
            >
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
                  done || active
                    ? "bg-[var(--accent)] text-[#0c1110]"
                    : "bg-[var(--line)] text-[var(--ink-muted)]"
                }`}
              >
                {done && !active ? "✓" : i + 1}
              </span>
              <span className="whitespace-nowrap">{s.label}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function WizardCard({
  title,
  subtitle,
  children,
  pulse,
}: {
  title: string;
  subtitle: React.ReactNode;
  children: React.ReactNode;
  pulse?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-[var(--accent)]/40 bg-[var(--panel-active)] p-5 md:p-6">
      <div className="flex items-center gap-3">
        {pulse ? (
          <span className="activity-pulse inline-flex h-3 w-3 rounded-full bg-[var(--accent)]" />
        ) : null}
        <h2 className="text-xl font-semibold tracking-tight md:text-2xl">{title}</h2>
      </div>
      <p className="mt-2 max-w-lg text-sm leading-snug text-[var(--ink-muted)]">{subtitle}</p>
      <div className="mt-4">{children}</div>
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
      ? "border border-[var(--line)] bg-black/20 text-[var(--ink)] hover:border-[var(--accent)]/40"
      : tone === "danger"
        ? "bg-[var(--err)] text-[#0c1110]"
        : "bg-[var(--accent)] text-[#0c1110] hover:bg-[var(--accent-deep)]";
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

function Mono({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-4">
      <div className="text-[10px] tracking-wide text-[var(--ink-muted)] uppercase">{label}</div>
      <div className="mt-1 break-all font-[family-name:var(--font-mono)] text-xs">{children}</div>
    </div>
  );
}
