/**
 * E2E integration tests for the Uniswap V4 Indexer.
 *
 * Uses HyperIndex's createTestIndexer() to replay real chain events through
 * the handlers and snapshot the resulting entity changes. See
 * .claude/skills/testing/SKILL.md for conventions.
 *
 * Blocks are drawn from Ethereum mainnet at or after this chain's configured
 * start_block (25638238) — the test harness rejects an earlier range outright.
 *
 * Every fixture here uses a real NFTX pool, because that is all the indexer sees:
 * Initialize selects our hooks, and Locker / flex-hook discovery is idempotent.
 * Foreign pools in the same blocks reach handlers but never create Pool, Tick,
 * Swap or ModifyLiquidity entities.
 */

import { describe, it } from "vitest";
import { createTestIndexer, BigDecimal } from "envio";

const abs = (v: BigDecimal) =>
  v.lt(new BigDecimal("0")) ? v.times(new BigDecimal("-1")) : v;

describe("Uniswap V4 Indexer", () => {
  it("Does not create Ticks for ModifyLiquidity on a pool it has not seen created", async (t) => {
    const indexer = createTestIndexer();

    // Block 25703423 carries four ModifyLiquidity events. Three are on other
    // people's pools and are ignored by the handler; the fourth is NFTX pool
    // 0x0e660964…, whose CollectionInitialized landed ~12k blocks earlier and so
    // is outside this range. The handler must cope with the Pool row being
    // absent — that is what makes a late start_block safe — and write no Ticks.
    t.expect(
      await indexer.process({
        chains: {
          1: { startBlock: 25703423, endBlock: 25703423 },
        },
      }),
      "pools with no prior NFTX creation event yield no Tick entities"
    ).toMatchInlineSnapshot(`
      {
        "changes": [
          {
            "Position": {
              "sets": [
                {
                  "chainId": 1n,
                  "createdAtTimestamp": 1786109711n,
                  "id": "1_365990",
                  "origin": "0x743BD1f2498ca0545bFbd977E5DDddd52f4eaD72",
                  "owner": "0x743BD1f2498ca0545bFbd977E5DDddd52f4eaD72",
                  "tokenId": 365990n,
                },
                {
                  "chainId": 1n,
                  "createdAtTimestamp": 1786109711n,
                  "id": "1_365991",
                  "origin": "0x2403D4F74a1A5E29fFEBAe64dfAB963C0c690ae6",
                  "owner": "0x2403D4F74a1A5E29fFEBAe64dfAB963C0c690ae6",
                  "tokenId": 365991n,
                },
                {
                  "chainId": 1n,
                  "createdAtTimestamp": 1786109711n,
                  "id": "1_365992",
                  "origin": "0xB8A70b4d1547bf6193bd67A73F4F98ea9FD0A973",
                  "owner": "0xB8A70b4d1547bf6193bd67A73F4F98ea9FD0A973",
                  "tokenId": 365992n,
                },
              ],
            },
            "Transfer": {
              "sets": [
                {
                  "chainId": 1n,
                  "from": "0x0000000000000000000000000000000000000000",
                  "id": "1_25703423_559",
                  "logIndex": 559n,
                  "origin": "0x743BD1f2498ca0545bFbd977E5DDddd52f4eaD72",
                  "position_id": "1_365990",
                  "timestamp": 1786109711n,
                  "to": "0x743BD1f2498ca0545bFbd977E5DDddd52f4eaD72",
                  "tokenId": 365990n,
                  "transaction": "0x353b331f6f226717156382ea95c69ffbca39e40937e6c74752c13ea2030a76de",
                },
                {
                  "chainId": 1n,
                  "from": "0x0000000000000000000000000000000000000000",
                  "id": "1_25703423_842",
                  "logIndex": 842n,
                  "origin": "0x2403D4F74a1A5E29fFEBAe64dfAB963C0c690ae6",
                  "position_id": "1_365991",
                  "timestamp": 1786109711n,
                  "to": "0x2403D4F74a1A5E29fFEBAe64dfAB963C0c690ae6",
                  "tokenId": 365991n,
                  "transaction": "0x0aeca8c5851495d1aa14dc2a6e6c00f9831105e383fd0511f4dc55bd9b5ab13c",
                },
                {
                  "chainId": 1n,
                  "from": "0x0000000000000000000000000000000000000000",
                  "id": "1_25703423_983",
                  "logIndex": 983n,
                  "origin": "0xB8A70b4d1547bf6193bd67A73F4F98ea9FD0A973",
                  "position_id": "1_365992",
                  "timestamp": 1786109711n,
                  "to": "0xB8A70b4d1547bf6193bd67A73F4F98ea9FD0A973",
                  "tokenId": 365992n,
                  "transaction": "0xb1b929f366e8e9be9823efebfbef09804fff9770399f3491f1aeaa6b16550bc5",
                },
              ],
            },
            "block": 25703423,
            "chainId": 1,
            "eventsProcessed": 36,
          },
        ],
      }
    `);
  });

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
  }, 300000);
});
