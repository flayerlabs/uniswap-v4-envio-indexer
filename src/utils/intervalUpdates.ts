/*
 * Per-pool time-bucketed aggregates (PoolHourData / PoolDayData).
 *
 * Ported from the upstream Uniswap v4 subgraph
 * (Uniswap/v4-subgraph src/utils/intervalUpdates.ts `updatePoolDayData` /
 * `updatePoolHourData`, called from src/mappings/swap.ts:310-311,
 * modifyLiquidity.ts:177-178 and poolManager.ts:196-197). Field semantics are
 * kept identical so a consumer can read these buckets exactly as it read the
 * subgraph's: `open`/`high`/`low`/`close` are `token0Price` (token1 per token0),
 * volumes are per-bucket sums, and everything else is an end-of-period snapshot.
 *
 * Two deliberate departures from a literal port:
 *
 * 1. The upstream functions call `Pool.load()` themselves and rely on The Graph's
 *    write-ahead entity cache to see the post-swap price. Envio handlers build
 *    the pool as a plain object, so the caller passes the already-updated `pool`
 *    in. Callers MUST pass the post-update pool, or OHLC lags a swap.
 * 2. Loading is split out into `loadPoolIntervals`. Envio runs handlers twice and
 *    only batches `context.*.get()` calls made before the `context.isPreload`
 *    return, so the reads have to happen in the handler's top load block while
 *    the writes happen after it.
 */
import {
  BigDecimal,
  type EvmOnEventContext,
  type Pool,
  type PoolDayData,
  type PoolHourData,
} from "envio";
import { ONE_BI, ZERO_BD, ZERO_BI } from "./constants";
import { sanitizeBD } from "./index";

// Matches the alias src/utils/pricing.ts uses for the same type.
type handlerContext = EvmOnEventContext;

export const SECONDS_PER_HOUR = 3600;
export const SECONDS_PER_DAY = 86400;

/** Volume/fee amounts to add to the buckets. Snapshot-only callers pass nothing. */
export interface IntervalVolumeDeltas {
  volumeToken0: BigDecimal;
  volumeToken1: BigDecimal;
  volumeUSD: BigDecimal;
  feesUSD: BigDecimal;
}

const NO_VOLUME: IntervalVolumeDeltas = {
  volumeToken0: ZERO_BD,
  volumeToken1: ZERO_BD,
  volumeUSD: ZERO_BD,
  feesUSD: ZERO_BD,
};

/**
 * Bucket ids are `<pool entity id>-<bucket index>`, i.e.
 * `<chainId>_<poolId>-<index>`. The chain prefix comes free with the pool id;
 * the hyphen before the index mirrors upstream.
 */
export function poolIntervalIds(
  poolEntityId: string,
  timestamp: number
): { hourId: string; dayId: string; hourStartUnix: bigint; dayStartUnix: bigint } {
  const hourIndex = Math.floor(timestamp / SECONDS_PER_HOUR);
  const dayIndex = Math.floor(timestamp / SECONDS_PER_DAY);
  return {
    hourId: `${poolEntityId}-${hourIndex}`,
    dayId: `${poolEntityId}-${dayIndex}`,
    hourStartUnix: BigInt(hourIndex * SECONDS_PER_HOUR),
    dayStartUnix: BigInt(dayIndex * SECONDS_PER_DAY),
  };
}

/**
 * Both bucket reads for a pool at a timestamp. Call this from the handler's top
 * load block, before the `context.isPreload` return.
 */
export async function loadPoolIntervals(
  context: handlerContext,
  poolEntityId: string,
  timestamp: number
): Promise<{ hour: PoolHourData | undefined; day: PoolDayData | undefined }> {
  const { hourId, dayId } = poolIntervalIds(poolEntityId, timestamp);
  const [hour, day] = await Promise.all([
    context.PoolHourData.get(hourId),
    context.PoolDayData.get(dayId),
  ]);
  return { hour, day };
}

/**
 * Fields common to both bucket shapes. A new bucket seeds all four OHLC values
 * from the current price; an existing one widens high/low and moves close.
 */
function applyInterval(
  pool: Pool,
  existing: PoolHourData | PoolDayData | undefined,
  deltas: IntervalVolumeDeltas
): Omit<PoolHourData, "id" | "periodStartUnix"> {
  const base =
    existing ??
    ({
      chainId: pool.chainId,
      pool: pool.id,
      volumeToken0: ZERO_BD,
      volumeToken1: ZERO_BD,
      volumeUSD: ZERO_BD,
      feesUSD: ZERO_BD,
      txCount: ZERO_BI,
      open: pool.token0Price,
      high: pool.token0Price,
      low: pool.token0Price,
      close: pool.token0Price,
      liquidity: pool.liquidity,
      sqrtPrice: pool.sqrtPrice,
      token0Price: pool.token0Price,
      token1Price: pool.token1Price,
      tick: pool.tick,
      tvlUSD: pool.totalValueLockedUSD,
    } satisfies Omit<PoolHourData, "id" | "periodStartUnix">);

  return {
    chainId: pool.chainId,
    pool: pool.id,
    high: pool.token0Price.gt(base.high) ? pool.token0Price : base.high,
    low: pool.token0Price.lt(base.low) ? pool.token0Price : base.low,
    open: base.open,
    close: pool.token0Price,
    liquidity: pool.liquidity,
    sqrtPrice: pool.sqrtPrice,
    token0Price: pool.token0Price,
    token1Price: pool.token1Price,
    tick: pool.tick,
    tvlUSD: pool.totalValueLockedUSD,
    volumeToken0: base.volumeToken0.plus(deltas.volumeToken0),
    volumeToken1: base.volumeToken1.plus(deltas.volumeToken1),
    volumeUSD: sanitizeBD(base.volumeUSD.plus(deltas.volumeUSD)),
    feesUSD: sanitizeBD(base.feesUSD.plus(deltas.feesUSD)),
    txCount: base.txCount + ONE_BI,
  };
}

export function updatePoolHourData(
  pool: Pool,
  existing: PoolHourData | undefined,
  timestamp: number,
  deltas: IntervalVolumeDeltas = NO_VOLUME
): PoolHourData {
  const { hourId, hourStartUnix } = poolIntervalIds(pool.id, timestamp);
  return { id: hourId, periodStartUnix: hourStartUnix, ...applyInterval(pool, existing, deltas) };
}

export function updatePoolDayData(
  pool: Pool,
  existing: PoolDayData | undefined,
  timestamp: number,
  deltas: IntervalVolumeDeltas = NO_VOLUME
): PoolDayData {
  const { dayId, dayStartUnix } = poolIntervalIds(pool.id, timestamp);
  return { id: dayId, date: dayStartUnix, ...applyInterval(pool, existing, deltas) };
}
