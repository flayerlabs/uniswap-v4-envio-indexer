import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTestIndexer } from "envio";
import { isNftxHook, NFTX_HOOKS } from "./utils/nftxHooks";

describe("NFTX hook discovery", () => {
  it("covers every configured chain, including chains without any pools yet", () => {
    const config = readFileSync(new URL("../config.yaml", import.meta.url), "utf8");
    const chains = [...config.matchAll(/^  - id: (\d+)$/gm)].map((match) => Number(match[1]));
    expect(Object.keys(NFTX_HOOKS).map(Number).sort()).toEqual(chains.sort());
    for (const chain of chains) {
      expect(isNftxHook(chain, "0xaa49ADaDD33c5E953b645567AFb10CBbba63afC4")).toBe(true);
    }
    expect(isNftxHook(1, "0xC26A5Cb51b1818F62a4C6693a9a1feDB3340efc4")).toBe(true);
    expect(isNftxHook(42161, "0xC26A5Cb51b1818F62a4C6693a9a1feDB3340efc4")).toBe(false);
    expect(isNftxHook(999999, "0xaa49ADaDD33c5E953b645567AFb10CBbba63afC4")).toBe(false);
  });

  it("ignores foreign and hookless pool creation, deposits and swaps", async () => {
    const indexer = createTestIndexer();
    const id = `0x${"ab".repeat(32)}`;
    await indexer.process({ chains: { 1: { simulate: [
      { contract: "PoolManager", event: "Initialize", params: {
        id, hooks: "0x0000000000000000000000000000000000000000",
      } },
      { contract: "PoolManager", event: "Initialize", params: {
        id, hooks: "0x0000000000000000000000000000000000000001",
      } },
      { contract: "PoolManager", event: "ModifyLiquidity", params: {
        id, tickLower: -60n, tickUpper: 60n, liquidityDelta: 1000n,
      } },
      { contract: "PoolManager", event: "Swap", params: { id } },
    ] } } });
    expect(await indexer.Pool.getAll()).toEqual([]);
    expect(await indexer.Token.getAll()).toEqual([]);
    expect(await indexer.Tick.getAll()).toEqual([]);
    expect(await indexer.Swap.getAll()).toEqual([]);
    expect(await indexer.ModifyLiquidity.getAll()).toEqual([]);
    expect(await indexer.PoolManager.getAll()).toEqual([]);
  });
});
