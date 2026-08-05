/**
 * The compliance gate.
 *
 * CPP enforces policy at **ingress only**. The depositor's address is public on
 * chain the moment they fund a deposit, so screening it costs no privacy that
 * the deposit had not already spent. Everything downstream — who the token is
 * eventually paid to, and when — stays unlinkable, because the mint signs a
 * blinded point and never learns which redemption its signature settles.
 *
 * That is a deliberate trade, and it is worth being precise about what it does
 * and does not buy:
 *
 *  - It **does** keep screened-out funds from entering the anonymity set at
 *    all, which is what an operator subject to sanctions obligations needs.
 *  - It **does not** let anyone trace an exit back to an entrance, not even the
 *    operator. There is no viewing key and no escrowed link. If a policy
 *    question can only be answered by de-anonymising a past redemption, this
 *    design cannot answer it — by construction, not by omission.
 *
 * A refusal is not a seizure: the depositor calls `refund` and gets their funds
 * back. The gate can decline to admit money to the pool; it can never keep it.
 */

import { readFile } from "node:fs/promises";

import { resolveFromRoot } from "./config.js";

export type Decision = "allow" | "deny";

export interface ScreeningResult {
  decision: Decision;
  /** Human-readable justification, written to the audit log either way. */
  reason: string;
  /** Which provider decided. */
  provider: string;
}

export interface ScreeningProvider {
  readonly name: string;
  screen(address: string): Promise<ScreeningResult>;
}

// ---------------------------------------------------------------------------
// Denylist
// ---------------------------------------------------------------------------

/**
 * Screens against a local list of blocked addresses.
 *
 * This stands in for whatever list an operator is actually obliged to honour —
 * OFAC SDN, an internal risk list, a chain-analytics feed. The interface is the
 * point; the file is a placeholder a real deployment replaces.
 */
export class DenylistProvider implements ScreeningProvider {
  readonly name = "denylist";
  private readonly blocked: Set<string>;

  constructor(blocked: Iterable<string>) {
    this.blocked = new Set([...blocked].map((a) => a.trim().toUpperCase()).filter(Boolean));
  }

  /** Loads a JSON file of the form `{ "blocked": ["G...", "C..."] }`. */
  static async fromFile(path: string): Promise<DenylistProvider> {
    const parsed = JSON.parse(await readFile(resolveFromRoot(path), "utf8")) as { blocked?: string[] };
    return new DenylistProvider(parsed.blocked ?? []);
  }

  async screen(address: string): Promise<ScreeningResult> {
    const hit = this.blocked.has(address.trim().toUpperCase());
    return {
      decision: hit ? "deny" : "allow",
      reason: hit ? "address appears on the operator denylist" : "no denylist match",
      provider: this.name,
    };
  }
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

/**
 * Screens against a list of permitted addresses — the KYC'd-customers model,
 * where a bank runs a pool for its own verified users and everyone else is
 * refused at the door.
 *
 * Stricter than a denylist and, for many regulated operators, the only posture
 * their counsel will sign off on.
 */
export class AllowlistProvider implements ScreeningProvider {
  readonly name = "allowlist";
  private readonly allowed: Set<string>;

  constructor(allowed: Iterable<string>) {
    this.allowed = new Set([...allowed].map((a) => a.trim().toUpperCase()).filter(Boolean));
  }

  static async fromFile(path: string): Promise<AllowlistProvider> {
    const parsed = JSON.parse(await readFile(resolveFromRoot(path), "utf8")) as { allowed?: string[] };
    return new AllowlistProvider(parsed.allowed ?? []);
  }

  async screen(address: string): Promise<ScreeningResult> {
    const ok = this.allowed.has(address.trim().toUpperCase());
    return {
      decision: ok ? "allow" : "deny",
      reason: ok ? "address is on the operator allowlist" : "address is not on the allowlist",
      provider: this.name,
    };
  }
}

// ---------------------------------------------------------------------------
// External risk API
// ---------------------------------------------------------------------------

export interface RiskApiOptions {
  url: string;
  apiKey?: string;
  /** Scores at or above this threshold are refused. */
  denyAtOrAbove?: number;
  timeoutMs?: number;
}

/**
 * Calls an external risk-scoring API, expecting `{ "risk": <0..100> }`.
 *
 * **Fails closed.** A timeout or a malformed response denies the deposit rather
 * than admitting it. An operator who cannot screen has not screened, and the
 * depositor loses nothing but time — `refund` is always available.
 */
export class RiskApiProvider implements ScreeningProvider {
  readonly name = "risk-api";
  private readonly options: Required<Omit<RiskApiOptions, "apiKey">> & { apiKey?: string };

  constructor(options: RiskApiOptions) {
    this.options = {
      url: options.url,
      apiKey: options.apiKey,
      denyAtOrAbove: options.denyAtOrAbove ?? 70,
      timeoutMs: options.timeoutMs ?? 5_000,
    };
  }

  async screen(address: string): Promise<ScreeningResult> {
    const { url, apiKey, denyAtOrAbove, timeoutMs } = this.options;
    const signal = AbortSignal.timeout(timeoutMs);

    try {
      const response = await fetch(`${url}?address=${encodeURIComponent(address)}`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal,
      });
      if (!response.ok) {
        return { decision: "deny", reason: `risk API returned HTTP ${response.status}`, provider: this.name };
      }

      const body = (await response.json()) as { risk?: unknown };
      if (typeof body.risk !== "number" || Number.isNaN(body.risk)) {
        return { decision: "deny", reason: "risk API returned no usable score", provider: this.name };
      }
      if (body.risk >= denyAtOrAbove) {
        return {
          decision: "deny",
          reason: `risk score ${body.risk} >= threshold ${denyAtOrAbove}`,
          provider: this.name,
        };
      }
      return {
        decision: "allow",
        reason: `risk score ${body.risk} < threshold ${denyAtOrAbove}`,
        provider: this.name,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { decision: "deny", reason: `risk API unreachable: ${detail}`, provider: this.name };
    }
  }
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Runs providers in order and stops at the first `deny`.
 *
 * Unanimous-allow semantics: every provider must clear the address. With no
 * providers configured the policy allows everything, which is fine for a
 * testnet demo and must not be a production configuration — `Mint` logs a
 * warning when it sees one.
 */
export class PolicyEngine implements ScreeningProvider {
  readonly name = "policy";

  constructor(private readonly providers: ScreeningProvider[]) {}

  get isEmpty(): boolean {
    return this.providers.length === 0;
  }

  async screen(address: string): Promise<ScreeningResult> {
    for (const provider of this.providers) {
      const result = await provider.screen(address);
      if (result.decision === "deny") return result;
    }
    return {
      decision: "allow",
      reason: this.providers.length
        ? `cleared ${this.providers.map((p) => p.name).join(", ")}`
        : "no screening providers configured",
      provider: this.name,
    };
  }
}

/**
 * Builds the policy from the environment.
 *
 *   `CPP_DENYLIST_FILE`   JSON `{ "blocked": [...] }`
 *   `CPP_ALLOWLIST_FILE`  JSON `{ "allowed": [...] }`
 *   `CPP_RISK_API_URL`    external scorer (`CPP_RISK_API_KEY`, `CPP_RISK_THRESHOLD`)
 */
export async function policyFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<PolicyEngine> {
  const providers: ScreeningProvider[] = [];

  if (env.CPP_DENYLIST_FILE) {
    providers.push(await DenylistProvider.fromFile(env.CPP_DENYLIST_FILE));
  }
  if (env.CPP_ALLOWLIST_FILE) {
    providers.push(await AllowlistProvider.fromFile(env.CPP_ALLOWLIST_FILE));
  }
  if (env.CPP_RISK_API_URL) {
    providers.push(
      new RiskApiProvider({
        url: env.CPP_RISK_API_URL,
        apiKey: env.CPP_RISK_API_KEY,
        denyAtOrAbove: env.CPP_RISK_THRESHOLD ? Number(env.CPP_RISK_THRESHOLD) : undefined,
      }),
    );
  }

  return new PolicyEngine(providers);
}
