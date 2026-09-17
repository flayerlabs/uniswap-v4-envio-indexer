import { describe, expect, it } from "vitest";
import { BigDecimal, createTestIndexer } from "envio";

const POOL = "1_0x87b6681f23e615792599a64be55151b0bea86daa42f357ddd2a3eaaee705f569";

describe("initial pool reserves", () => {
  it("discovers position 406489's new flex pool and records its first deposit without a pool list", async () => {
    const indexer = createTestIndexer();
    const id = "1_0x7169c13961289ed8b9fc790ca5f7187246b8b769d347e57643df223f41de7000";
    // FlexPoolInitialized at log 40, Initialize at 41, ModifyLiquidity at 45.
    // This pool did not exist in the former generated allowlist.
    await indexer.process({ chains: { 1: { startBlock: 25997033, endBlock: 25997033 } } });
    const pool = await indexer.Pool.getOrThrow(id);
    // A second transaction swaps this pool later in the same block.
    expect(pool.totalValueLockedToken0.toString()).toBe("1.948176949373686537");
    expect(pool.totalValueLockedToken1.toString()).toBe("1.736861837116623784");
    expect(pool.liquidity).toBe(1839291503270588969n);
    expect(pool.txCount).toBe(2n);
    const deposits = (await indexer.ModifyLiquidity.getAll()).filter((entry) => entry.pool_id === id);
    expect(deposits).toHaveLength(1);
    expect(deposits[0]?.amount0.toString()).toBe("1.994991739332266005");
    expect(deposits[0]?.amount1.toString()).toBe("1.695742978432426104");

    await indexer.process({ chains: { 1: { startBlock: 25997034, endBlock: 25997168 } } });
    const swapped = await indexer.Pool.getOrThrow(id);
    const swaps = (await indexer.Swap.getAll()).filter((entry) => entry.pool === id);
    expect(swaps.length).toBeGreaterThan(0);
    expect(swapped.tick).toBe(-1867n);
    expect(swapped.totalValueLockedToken0.gt(new BigDecimal(0))).toBe(true);
    expect(swapped.totalValueLockedToken1.gt(new BigDecimal(0))).toBe(true);
    for (const [reserve, amount] of [
      ["totalValueLockedToken0", "amount0"],
      ["totalValueLockedToken1", "amount1"],
    ] as const) {
      // Indexed Swap rows normalize the caller deltas into reserve deltas.
      // No deposit or swap may be silently excluded.
      const expected = swaps.reduce((total, swap) => total.plus(swap[amount]), deposits[0]![amount]);
      expect(swapped[reserve].toString()).toBe(expected.toString());
    }
    expect((await indexer.Pool.getAll()).every((entry) =>
      entry.hooks.toLowerCase() === "0xaa49adadd33c5e953b645567afb10cbbba63afc4" ||
      entry.hooks.toLowerCase() === "0xc26a5cb51b1818f62a4c6693a9a1fedb3340efc4"
    )).toBe(true);
  }, 120000);

  it("records the deposit before the later Locker event and retains it through the first swap", async () => {
    const indexer = createTestIndexer();
    // Real creation tx 0x8acd2da0…c403f0: Initialize at log 355,
    // ModifyLiquidity at 363, funding transfers at 365/366, Locker event at 373.
    await indexer.process({ chains: { 1: { startBlock: 25653470, endBlock: 25653470 } } });
    const pool = await indexer.Pool.getOrThrow(POOL);
    expect(pool.totalValueLockedToken0.toString()).toBe("16.157399999999999999");
    expect(pool.totalValueLockedToken1.toString()).toBe("41.999999999999999999");
    expect(pool.liquidity).toBe(26050159308533988311n);
    const additions = await indexer.ModifyLiquidity.getAll();
    expect(additions.filter((entry) => entry.pool_id === POOL)).toHaveLength(1);
    // The later NFTX event must not create a second pool or reset its reserves.
    const managers = await indexer.PoolManager.getAll();
    expect(managers.reduce((count, manager) => count + manager.poolCount, 0n)).toBe(1n);

    await indexer.process({ chains: { 1: { startBlock: 25653471, endBlock: 25653471 } } });
    const swapped = await indexer.Pool.getOrThrow(POOL);
    expect(swapped.totalValueLockedToken0.toString()).toBe("16.357399999999999999");
    expect(swapped.totalValueLockedToken1.toString()).toBe("41.491036709139377338");
    expect(swapped.totalValueLockedToken0.gt(new BigDecimal(0))).toBe(true);
    expect(swapped.totalValueLockedToken1.gt(new BigDecimal(0))).toBe(true);
  }, 120000);
});
