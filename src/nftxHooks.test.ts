import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isNftxHook, NFTX_HOOKS } from "./utils/nftxHooks";

/**
 * config.yaml decides which addresses are ingested; src/utils/nftxHooks.ts
 * decides which pools the receipt replay admits. The two must name the same
 * deployments on the same chains, or a chain either fetches receipts it then
 * discards every pool from, or never fetches at all.
 */
describe("NFTX hook deployments", () => {
  const config = readFileSync(new URL("../config.yaml", import.meta.url), "utf8");
  // Everything after `chains:` is one block per chain, split on `  - id:`.
  const chainBlocks = config
    .slice(config.indexOf("\nchains:"))
    .split(/^  - id: /m)
    .slice(1)
    .map((block) => ({ id: Number(block.slice(0, block.indexOf("\n"))), body: block }));

  it("covers every configured chain, including chains without any pools yet", () => {
    const chains = chainBlocks.map((chain) => chain.id);
    expect(chains.length).toBeGreaterThan(0);
    expect(Object.keys(NFTX_HOOKS).map(Number).sort()).toEqual([...chains].sort());
    for (const chain of chains) {
      expect(isNftxHook(chain, "0xaa49ADaDD33c5E953b645567AFb10CBbba63afC4")).toBe(true);
    }
    expect(isNftxHook(1, "0xC26A5Cb51b1818F62a4C6693a9a1feDB3340efc4")).toBe(true);
    expect(isNftxHook(42161, "0xC26A5Cb51b1818F62a4C6693a9a1feDB3340efc4")).toBe(false);
    expect(isNftxHook(999999, "0xaa49ADaDD33c5E953b645567AFb10CBbba63afC4")).toBe(false);
  });

  it("subscribes to exactly the hook addresses the replay admits, on every chain", () => {
    for (const chain of chainBlocks) {
      const subscribed = [...chain.body.matchAll(/^\s+- (0x[0-9a-fA-F]{40})$/gm)].map((m) => m[1]!.toLowerCase());
      const hooks = NFTX_HOOKS[chain.id]!;
      for (const hook of hooks) {
        expect(subscribed, `chain ${chain.id} must ingest hook ${hook}`).toContain(hook);
      }
      // Everything subscribed is a hook or the Locker; nothing chain-wide.
      for (const address of subscribed) {
        expect(
          hooks.includes(address) || address === "0xb4c5b5235b98114e9dc227b54e088c11680b2385",
          `chain ${chain.id} subscribes to ${address}, which is neither a hook nor the Locker`,
        ).toBe(true);
      }
    }
  });

  it("does not subscribe to any Uniswap contract", () => {
    expect(config).not.toMatch(/name: PoolManager/);
    expect(config).not.toMatch(/name: PositionManager/);
  });
});
