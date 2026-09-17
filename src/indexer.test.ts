/**
 * E2E integration tests for the Uniswap V4 Indexer.
 *
 * Uses HyperIndex's createTestIndexer() to replay real chain events through
 * the handlers and snapshot the resulting entity changes. See
 * .claude/skills/indexer-testing/SKILL.md for conventions. Needs
 * ENVIO_API_TOKEN (HyperSync) and reaches the public mainnet RPC for receipts.
 *
 * Blocks are drawn from Ethereum mainnet at or after this chain's configured
 * start_block (25638238) — the test harness rejects an earlier range outright.
 *
 * Only NFTX's own contracts are subscribed, so a block with no NFTX activity
 * delivers no events at all, and every receipt the handlers fetch belongs to a
 * transaction that touched an NFTX pool.
 */

import { describe, it } from "vitest";
import { createTestIndexer, BigDecimal } from "envio";

const abs = (v: BigDecimal) =>
  v.lt(new BigDecimal("0")) ? v.times(new BigDecimal("-1")) : v;

describe("Uniswap V4 Indexer", () => {
  it("Sees nothing in a block with only foreign pool activity", async (t) => {
    const indexer = createTestIndexer();

    // Block 25703423 carries four ModifyLiquidity events on the PoolManager and
    // three PositionManager mints. Three deposits are on other people's pools;
    // the fourth is NFTX pool 0x0e660964…, whose CollectionInitialized landed
    // ~12k blocks earlier — but that deposit's own PoolStateUpdated is what
    // would trigger a replay, and it is what this range delivers. So this block
    // must yield exactly that one pool's deposit and nothing else; in
    // particular no Position/Transfer rows and no Tick for a foreign pool.
    const result = await indexer.process({
      chains: {
        1: { startBlock: 25703423, endBlock: 25703423 },
      },
    });
    const entities = new Set(
      result.changes.flatMap((change) => Object.keys(change).filter((key) => !["block", "chainId", "eventsProcessed", "addresses"].includes(key)))
    );
    t.expect(entities.has("Position"), "PositionManager is no longer indexed").toBe(false);
    t.expect(entities.has("Transfer"), "PositionManager is no longer indexed").toBe(false);
    t.expect(entities.has("Tick"), "a deposit on a pool created before the range has no Pool row and writes nothing").toBe(false);
    t.expect(entities.has("ModifyLiquidity")).toBe(false);
    // The trigger fired and the receipt was replayed, but its pool is unknown
    // to this fresh database, so the only row is the transaction marker.
    t.expect([...entities]).toEqual(["IndexedTransaction"]);
    t.expect(result.changes.reduce((n, change) => n + change.eventsProcessed, 0)).toBe(1);
  }, 300000);

  it("Accumulates swap volume and OHLC into the hour and day buckets", async (t) => {
    const indexer = createTestIndexer();

    // 25691611 is where Locker.CollectionInitialized opens NFTX pool
    // 0x0e660964…; the next ~90 blocks carry 90 swaps on it, all inside one hour
    // bucket. So the buckets have to accumulate rather than reset, hour and day
    // must agree. Initialize creates our pool before its deposit;
    // the later Locker event must not reset its opening bucket.
    const result: any = await indexer.process({
      chains: { 1: { startBlock: 25691611, endBlock: 25691700 } },
    });

    const collect = (entity: string) =>
      result.changes.flatMap((change: any) => change[entity]?.sets ?? []);

    const swaps = collect("Swap");
    const hours = collect("PoolHourData");
    const days = collect("PoolDayData");

    t.expect(swaps.length, "the fixture range should contain swaps").toBeGreaterThan(1);

    // Every swap writes exactly one hour bucket and one day bucket.
    const pool = swaps[0].pool;
    t.expect(swaps.every((s: any) => s.pool === pool), "one pool in this range").toBe(true);

    const latestHour = hours[hours.length - 1];
    const latestDay = days[days.length - 1];

    // All writes land in the same bucket, so the ids never change.
    t.expect(new Set(hours.map((h: any) => h.id)).size).toBe(1);
    t.expect(new Set(days.map((d: any) => d.id)).size).toBe(1);
    t.expect(latestHour.id).toBe(`${pool}-${Number(latestHour.periodStartUnix) / 3600}`);
    t.expect(latestDay.id).toBe(`${pool}-${Number(latestDay.date) / 86400}`);
    t.expect(latestHour.pool).toBe(pool);

    // The invariant the API depends on: bucket volume is the sum of the swap
    // legs in that bucket. This is precisely what reading raw Swap rows and
    // summing them client-side used to compute.
    const sum = (key: string) =>
      swaps.reduce((acc: BigDecimal, s: any) => acc.plus(abs(s[key])), new BigDecimal("0"));

    t.expect(latestHour.volumeToken0.toString()).toBe(sum("amount0").toString());
    t.expect(latestHour.volumeToken1.toString()).toBe(sum("amount1").toString());

    // One hour inside one day, so the two buckets carry identical volume.
    t.expect(latestDay.volumeToken0.toString()).toBe(latestHour.volumeToken0.toString());
    t.expect(latestDay.volumeToken1.toString()).toBe(latestHour.volumeToken1.toString());

    // OHLC: open is pinned at the first write, close tracks the latest price,
    // and both sit inside [low, high].
    t.expect(latestHour.open.toString()).toBe(hours[0].open.toString());
    t.expect(latestHour.close.toString()).toBe(latestHour.token0Price.toString());
    t.expect(latestHour.high.lt(latestHour.open)).toBe(false);
    t.expect(latestHour.high.lt(latestHour.close)).toBe(false);
    t.expect(latestHour.low.gt(latestHour.open)).toBe(false);
    t.expect(latestHour.low.gt(latestHour.close)).toBe(false);

    // txCount counts every event that touched the pool, not just swaps, so it
    // is at least the swap count.
    t.expect(Number(latestHour.txCount)).toBeGreaterThanOrEqual(swaps.length);

    // Every swap was attributed from its receipt: original hash and sender.
    const replayed = new Set(collect("IndexedTransaction").map((tx: any) => tx.hash));
    t.expect(swaps.every((s: any) => replayed.has(s.transaction))).toBe(true);
    t.expect(swaps.every((s: any) => /^0x[0-9a-fA-F]{40}$/.test(s.origin))).toBe(true);
    t.expect(collect("Position")).toEqual([]);
  }, 600000);
});
