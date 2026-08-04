import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AllowlistProvider,
  DenylistProvider,
  PolicyEngine,
  RiskApiProvider,
} from "../src/screening.js";

const CLEAN = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
const DIRTY = "GDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYS7";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("denylist", () => {
  it("denies a listed address and allows everything else", async () => {
    const provider = new DenylistProvider([DIRTY]);
    expect((await provider.screen(DIRTY)).decision).toBe("deny");
    expect((await provider.screen(CLEAN)).decision).toBe("allow");
  });

  it("ignores case and surrounding whitespace", async () => {
    // Strkeys are uppercase, but an operator hand-editing a JSON list should
    // not be able to disable a sanction with a stray space.
    const provider = new DenylistProvider([`  ${DIRTY.toLowerCase()}  `]);
    expect((await provider.screen(DIRTY)).decision).toBe("deny");
  });

  it("explains itself either way", async () => {
    const provider = new DenylistProvider([DIRTY]);
    expect((await provider.screen(DIRTY)).reason).toMatch(/denylist/);
    expect((await provider.screen(CLEAN)).reason).toMatch(/no denylist match/);
  });
});

describe("allowlist", () => {
  it("denies anything not explicitly permitted", async () => {
    const provider = new AllowlistProvider([CLEAN]);
    expect((await provider.screen(CLEAN)).decision).toBe("allow");
    expect((await provider.screen(DIRTY)).decision).toBe("deny");
  });

  it("denies everything when the list is empty", async () => {
    expect((await new AllowlistProvider([]).screen(CLEAN)).decision).toBe("deny");
  });
});

describe("risk API", () => {
  function stubFetch(impl: () => Promise<unknown> | never): void {
    vi.stubGlobal("fetch", vi.fn(impl));
  }

  it("allows a score below the threshold", async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ risk: 10 }) }));
    const result = await new RiskApiProvider({ url: "https://risk.test", denyAtOrAbove: 70 }).screen(
      CLEAN,
    );
    expect(result.decision).toBe("allow");
  });

  it("denies at the threshold, not just above it", async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ risk: 70 }) }));
    const result = await new RiskApiProvider({ url: "https://risk.test", denyAtOrAbove: 70 }).screen(
      CLEAN,
    );
    expect(result.decision).toBe("deny");
  });

  it("fails closed when the API errors", async () => {
    stubFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    expect((await new RiskApiProvider({ url: "https://risk.test" }).screen(CLEAN)).decision).toBe(
      "deny",
    );
  });

  it("fails closed when the API is unreachable", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const result = await new RiskApiProvider({ url: "https://risk.test" }).screen(CLEAN);
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/unreachable/);
  });

  it("fails closed when the response has no usable score", async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ risk: "low" }) }));
    expect((await new RiskApiProvider({ url: "https://risk.test" }).screen(CLEAN)).decision).toBe(
      "deny",
    );
  });
});

describe("policy engine", () => {
  it("requires every provider to clear the address", async () => {
    const policy = new PolicyEngine([
      new AllowlistProvider([CLEAN, DIRTY]),
      new DenylistProvider([DIRTY]),
    ]);
    expect((await policy.screen(CLEAN)).decision).toBe("allow");
    expect((await policy.screen(DIRTY)).decision).toBe("deny");
  });

  it("stops at the first denial and reports which provider decided", async () => {
    const never = { name: "never-called", screen: vi.fn() };
    const policy = new PolicyEngine([new DenylistProvider([DIRTY]), never]);

    const result = await policy.screen(DIRTY);
    expect(result.provider).toBe("denylist");
    expect(never.screen).not.toHaveBeenCalled();
  });

  it("allows everything when unconfigured, and says so", async () => {
    const policy = new PolicyEngine([]);
    expect(policy.isEmpty).toBe(true);

    // The mint prints a warning on this path. Silently permissive screening is
    // the failure mode most likely to reach production unnoticed.
    const result = await policy.screen(DIRTY);
    expect(result.decision).toBe("allow");
    expect(result.reason).toMatch(/no screening providers/);
  });
});
