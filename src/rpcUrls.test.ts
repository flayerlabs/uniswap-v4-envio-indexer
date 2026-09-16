import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getRpcUrl } from "./utils/tokenMetadata";

/**
 * `getTokenMetadata` picks its RPC from a hard-coded switch, separate from the
 * sync sources in config.yaml. A chain indexed there but missing here does not
 * fail at startup: it fails inside the handler for the first pool created on
 * that chain, and the chain's sync halts at the block before it. This is what
 * stopped Arc on 2026-09-16, two blocks short of its first NFTX pool.
 */
const configuredChainIds = (): number[] => {
  const config = readFileSync(new URL("../config.yaml", import.meta.url), "utf8");
  const ids = [...config.matchAll(/^\s*-\s*id:\s*(\d+)\s*$/gm)].map((m) => Number(m[1]));
  expect(ids.length).toBeGreaterThan(0);
  return ids;
};

describe("getRpcUrl", () => {
  it.each(configuredChainIds())("has an RPC for configured chain %i", (chainId) => {
    const url = getRpcUrl(chainId);
    expect(() => new URL(url)).not.toThrow();
    expect(url).toMatch(/^https?:\/\//);
  });

  it("still refuses a chain that is not configured", () => {
    expect(() => getRpcUrl(999_999)).toThrow(/No RPC URL configured/);
  });

  it("prefers a dedicated Arc metadata RPC, then the sync RPC, then the public node", () => {
    const saved = { ...process.env };
    try {
      delete process.env.ENVIO_ARC_RPC_URL;
      delete process.env.ENVIO_RPC_URL_5042;
      expect(getRpcUrl(5042)).toBe("https://rpc.mainnet.arc.io");
      process.env.ENVIO_RPC_URL_5042 = "https://sync.example/arc";
      expect(getRpcUrl(5042)).toBe("https://sync.example/arc");
      process.env.ENVIO_ARC_RPC_URL = "https://meta.example/arc";
      expect(getRpcUrl(5042)).toBe("https://meta.example/arc");
    } finally {
      process.env = saved;
    }
  });
});

describe("metadata client retry policy", () => {
  it("backs off for long enough to outlast a per-second rate limit", async () => {
    const { METADATA_RPC_RETRY } = await import("./utils/tokenMetadata");
    // viem waits (2 ** attempt) * retryDelay between attempts, so the total
    // window before the effect throws (and halts the chain) is the geometric sum.
    const totalMs = Array.from(
      { length: METADATA_RPC_RETRY.retryCount },
      (_, i) => 2 ** i * METADATA_RPC_RETRY.retryDelay
    ).reduce((a, b) => a + b, 0);
    expect(totalMs).toBeGreaterThanOrEqual(60_000);
  });
});
