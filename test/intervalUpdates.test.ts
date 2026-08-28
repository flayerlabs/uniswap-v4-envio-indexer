/**
 * Tests for the per-pool time buckets (PoolHourData / PoolDayData).
 *
 * These replace an API-side reconstruction of windowed volume and OHLC from raw
 * `Swap` rows, so the properties that matter are the ones that reconstruction
 * got right by construction: buckets partition on wall-clock boundaries, volume
 * accumulates within a bucket and resets across one, `open` is pinned at the
 * first write while `close` tracks the latest, and `high`/`low` bound both.
 */
import { describe, it, expect } from "vitest";
import { BigDecimal, type Pool } from "envio";
import {
  poolIntervalIds,
  updatePoolDayData,
  updatePoolHourData,
  SECONDS_PER_DAY,
  SECONDS_PER_HOUR,
} from "../src/utils/intervalUpdates";

const bd = (v: string | number) => new BigDecimal(v.toString());

const POOL_ID = "1_0xabc";

/** A pool carrying only the fields the interval updaters read. */
function poolAt(token0Price: number, overrides: Partial<Pool> = {}): Pool {
  return {
    id: POOL_ID,
    chainId: 1n,
    token0Price: bd(token0Price),
    token1Price: bd(1 / token0Price),
    liquidity: 1000n,
    sqrtPrice: 42n,
    tick: 7n,
    totalValueLockedUSD: bd(0),
    ...overrides,
  } as Pool;
}

const volume = (amount0: number, amount1: number) => ({
  volumeToken0: bd(amount0),
  volumeToken1: bd(amount1),
  volumeUSD: bd(0),
  feesUSD: bd(0),
});

// 2026-08-28T12:34:56Z — deliberately not on an hour or day boundary.
const TS = 1787661296;

describe("poolIntervalIds", () => {
  it("floors to the containing hour and day, and namespaces by pool", () => {
    const { hourId, dayId, hourStartUnix, dayStartUnix } = poolIntervalIds(POOL_ID, TS);

    expect(Number(hourStartUnix) % SECONDS_PER_HOUR).toBe(0);
    expect(Number(dayStartUnix) % SECONDS_PER_DAY).toBe(0);
    expect(Number(hourStartUnix)).toBeLessThanOrEqual(TS);
    expect(TS - Number(hourStartUnix)).toBeLessThan(SECONDS_PER_HOUR);
    expect(hourId).toBe(`${POOL_ID}-${Math.floor(TS / SECONDS_PER_HOUR)}`);
    expect(dayId).toBe(`${POOL_ID}-${Math.floor(TS / SECONDS_PER_DAY)}`);
  });

  it("gives two pools in the same hour distinct bucket ids", () => {
    expect(poolIntervalIds("1_0xaaa", TS).hourId).not.toBe(
      poolIntervalIds("1_0xbbb", TS).hourId
    );
  });

  it("gives the same pool on two chains distinct bucket ids", () => {
    expect(poolIntervalIds("1_0xabc", TS).hourId).not.toBe(
      poolIntervalIds("42161_0xabc", TS).hourId
    );
  });
});

describe("updatePoolHourData", () => {
  it("seeds all four OHLC values from the current price on a new bucket", () => {
    const bucket = updatePoolHourData(poolAt(100), undefined, TS, volume(1, 100));

    expect(bucket.open.toString()).toBe("100");
    expect(bucket.high.toString()).toBe("100");
    expect(bucket.low.toString()).toBe("100");
    expect(bucket.close.toString()).toBe("100");
    expect(bucket.txCount).toBe(1n);
    expect(bucket.volumeToken0.toString()).toBe("1");
    expect(bucket.pool).toBe(POOL_ID);
  });

  it("pins open, moves close, and widens high/low across writes", () => {
    let bucket = updatePoolHourData(poolAt(100), undefined, TS, volume(1, 100));
    bucket = updatePoolHourData(poolAt(120), bucket, TS + 10, volume(1, 120));
    bucket = updatePoolHourData(poolAt(80), bucket, TS + 20, volume(1, 80));
    bucket = updatePoolHourData(poolAt(90), bucket, TS + 30, volume(1, 90));

    expect(bucket.open.toString()).toBe("100");
    expect(bucket.high.toString()).toBe("120");
    expect(bucket.low.toString()).toBe("80");
    expect(bucket.close.toString()).toBe("90");
    expect(bucket.txCount).toBe(4n);
    expect(bucket.volumeToken0.toString()).toBe("4");
    expect(bucket.volumeToken1.toString()).toBe("390");
  });

  it("keeps high >= close >= low and high >= open >= low", () => {
    let bucket = updatePoolHourData(poolAt(100), undefined, TS);
    for (const price of [140, 60, 110, 95]) {
      bucket = updatePoolHourData(poolAt(price), bucket, TS + 1);
    }

    // BigDecimal exposes gt/lt only, so bound with the negations.
    expect(bucket.high.lt(bucket.open)).toBe(false);
    expect(bucket.high.lt(bucket.close)).toBe(false);
    expect(bucket.low.gt(bucket.open)).toBe(false);
    expect(bucket.low.gt(bucket.close)).toBe(false);
  });

  it("starts a fresh bucket at the hour boundary rather than accumulating", () => {
    const first = updatePoolHourData(poolAt(100), undefined, TS, volume(5, 500));
    const nextHourTs = TS + SECONDS_PER_HOUR;

    expect(poolIntervalIds(POOL_ID, nextHourTs).hourId).not.toBe(first.id);

    // The handler's `.get()` misses on the new id, so `existing` is undefined.
    const second = updatePoolHourData(poolAt(130), undefined, nextHourTs, volume(2, 260));
    expect(second.volumeToken0.toString()).toBe("2");
    expect(second.open.toString()).toBe("130");
    expect(second.txCount).toBe(1n);
  });

  it("takes an end-of-period snapshot of pool state", () => {
    const pool = poolAt(100, {
      liquidity: 999n,
      sqrtPrice: 123n,
      tick: -50n,
      totalValueLockedUSD: bd(12345),
    });
    const bucket = updatePoolHourData(pool, undefined, TS);

    expect(bucket.liquidity).toBe(999n);
    expect(bucket.sqrtPrice).toBe(123n);
    expect(bucket.tick).toBe(-50n);
    expect(bucket.tvlUSD.toString()).toBe("12345");
  });

  it("records a snapshot with no volume when called without deltas", () => {
    const bucket = updatePoolHourData(poolAt(100), undefined, TS);

    expect(bucket.volumeToken0.toString()).toBe("0");
    expect(bucket.volumeToken1.toString()).toBe("0");
    expect(bucket.txCount).toBe(1n);
  });
});

describe("updatePoolDayData", () => {
  it("accumulates across hours within the same day", () => {
    let bucket = updatePoolDayData(poolAt(100), undefined, TS, volume(1, 100));
    bucket = updatePoolDayData(poolAt(120), bucket, TS + SECONDS_PER_HOUR, volume(1, 120));

    expect(bucket.date).toBe(poolIntervalIds(POOL_ID, TS).dayStartUnix);
    expect(bucket.volumeToken0.toString()).toBe("2");
    expect(bucket.open.toString()).toBe("100");
    expect(bucket.close.toString()).toBe("120");
  });

  it("starts a fresh bucket at the day boundary", () => {
    const first = updatePoolDayData(poolAt(100), undefined, TS, volume(5, 500));
    expect(poolIntervalIds(POOL_ID, TS + SECONDS_PER_DAY).dayId).not.toBe(first.id);
  });
});
