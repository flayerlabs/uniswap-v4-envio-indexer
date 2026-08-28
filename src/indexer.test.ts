/**
 * E2E integration tests for the Uniswap V4 Indexer.
 *
 * Uses HyperIndex's createTestIndexer() to replay real chain events through
 * the handlers and snapshot the resulting entity changes. See
 * .claude/skills/testing/SKILL.md for conventions.
 *
 * Blocks are drawn from Ethereum mainnet at or after this chain's configured
 * start_block (25638238) — the test harness rejects an earlier range outright.
 */

import { describe, it } from "vitest";
import { createTestIndexer, BigDecimal } from "envio";

const abs = (v: BigDecimal) =>
  v.lt(new BigDecimal("0")) ? v.times(new BigDecimal("-1")) : v;

describe("Uniswap V4 Indexer", () => {
  it("Does not create Ticks for ModifyLiquidity on unknown pools", async (t) => {
    const indexer = createTestIndexer();

    t.expect(
      await indexer.process({
        chains: {
          1: { startBlock: 25638247, endBlock: 25638247 },
        },
      }),
      "ModifyLiquidity events whose pool is unknown (no prior Initialize within the indexed range) should be processed without writing Tick entities. This is what makes the late start_block safe. The block also contains a PositionManager mint, captured as Position + Transfer."
    ).toMatchInlineSnapshot(`
      {
        "changes": [
          {
            "Position": {
              "sets": [
                {
                  "chainId": 1n,
                  "createdAtTimestamp": 1785325175n,
                  "id": "1_354271",
                  "origin": "0x0984ce9151a72b1711d768D90D7700f68059776f",
                  "owner": "0xf5b3e21B4C596c84222d98e849aE5f55768d4A36",
                  "tokenId": 354271n,
                },
              ],
            },
            "Transfer": {
              "sets": [
                {
                  "chainId": 1n,
                  "from": "0x0000000000000000000000000000000000000000",
                  "id": "1_25638247_48",
                  "logIndex": 48n,
                  "origin": "0x0984ce9151a72b1711d768D90D7700f68059776f",
                  "position_id": "1_354271",
                  "timestamp": 1785325175n,
                  "to": "0xf5b3e21B4C596c84222d98e849aE5f55768d4A36",
                  "tokenId": 354271n,
                  "transaction": "0x192d23b817d6bf299fcfb3416b8d34208a3f6d5ba95b30e82ad2a17ab270b326",
                },
              ],
            },
            "block": 25638247,
            "chainId": 1,
            "eventsProcessed": 9,
          },
        ],
      }
    `);
  });

  it("Accumulates swap volume and OHLC into the hour and day buckets", async (t) => {
    const indexer = createTestIndexer();

    // 25638359 initialises a pool and swaps on it; 25638365-67 carry five more
    // swaps on the same pool, all inside one hour — so the buckets have to
    // accumulate rather than reset, and hour and day must agree.
    const result: any = await indexer.process({
      chains: { 1: { startBlock: 25638359, endBlock: 25638367 } },
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
  }, 300000);
});
