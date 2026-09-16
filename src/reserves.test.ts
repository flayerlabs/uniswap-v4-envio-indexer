import { describe, expect, it } from "vitest";
import { BigDecimal, createTestIndexer } from "envio";

const POOL = "1_0x87b6681f23e615792599a64be55151b0bea86daa42f357ddd2a3eaaee705f569";

describe("initial pool reserves", () => {
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
