/*
 * Swap accounting for a PoolManager.Swap log in a replayed receipt. Ported from
 * the upstream handler; USD/ETH valuation removed. Token-denominated volume,
 * fees, reserves, price and the interval candles are all kept.
 */
import { BigDecimal, type Swap } from "envio";
import { getChainConfig } from "../utils/chains";
import { convertTokenToDecimal } from "../utils";
import { ZERO_BD } from "../utils/constants";
import { sqrtPriceX96ToTokenPrices } from "../utils/pricing";
import { loadPoolIntervals, updatePoolDayData, updatePoolHourData } from "../utils/intervalUpdates";
import type { HandlerContext, ReplayTransaction } from "./context";
import { poolEntityId, poolManagerEntityId } from "./createPool";

export interface SwapArgs {
  id: string;
  sender: string;
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: bigint;
  fee: bigint;
  logIndex: number;
}

const abs = (value: BigDecimal): BigDecimal => (value.lt(ZERO_BD) ? value.times(new BigDecimal("-1")) : value);

/** Returns true when the log was on an NFTX pool and was applied. */
export const applySwap = async (context: HandlerContext, tx: ReplayTransaction, args: SwapArgs): Promise<boolean> => {
  const chainConfig = getChainConfig(tx.chainId);
  if (chainConfig.poolsToSkip.includes(args.id)) return false;

  const poolId = poolEntityId(tx.chainId, args.id);
  const existingPool = await context.Pool.get(poolId);
  if (!existingPool) return false;

  const [existingPoolManager, existingToken0, existingToken1, existingHookStats, intervals] = await Promise.all([
    context.PoolManager.get(poolManagerEntityId(tx.chainId)),
    context.Token.get(existingPool.token0),
    context.Token.get(existingPool.token1),
    context.HookStats.get(`${tx.chainId}_${existingPool.hooks}`),
    loadPoolIntervals(context, poolId, tx.block.timestamp),
  ]);
  if (context.isPreload) return true;
  if (!existingToken0 || !existingToken1 || !existingPoolManager || !existingHookStats) {
    throw new Error(`Pool ${poolId} exists without its tokens, PoolManager or HookStats rows`);
  }

  const prices = sqrtPriceX96ToTokenPrices(args.sqrtPriceX96, existingToken0, existingToken1, chainConfig.nativeTokenDetails);
  // v4 reports the caller's deltas: negative means the pool received the
  // amount. Invert so amounts are pool-side, as the upstream schema documents.
  const amount0 = convertTokenToDecimal(args.amount0, existingToken0.decimals).times(new BigDecimal("-1"));
  const amount1 = convertTokenToDecimal(args.amount1, existingToken1.decimals).times(new BigDecimal("-1"));
  const amount0Abs = abs(amount0);
  const amount1Abs = abs(amount1);
  const feeFraction = new BigDecimal(args.fee.toString()).div(new BigDecimal("1000000"));

  const pool = {
    ...existingPool,
    // Dynamic-fee pools report the effective fee per swap.
    feeTier: args.fee,
    txCount: existingPool.txCount + 1n,
    sqrtPrice: args.sqrtPriceX96,
    tick: args.tick,
    token0Price: prices[0],
    token1Price: prices[1],
    totalValueLockedToken0: existingPool.totalValueLockedToken0.plus(amount0),
    totalValueLockedToken1: existingPool.totalValueLockedToken1.plus(amount1),
    liquidity: args.liquidity,
    volumeToken0: existingPool.volumeToken0.plus(amount0Abs),
    volumeToken1: existingPool.volumeToken1.plus(amount1Abs),
    collectedFeesToken0: existingPool.collectedFeesToken0.plus(amount0Abs.times(feeFraction)),
    collectedFeesToken1: existingPool.collectedFeesToken1.plus(amount1Abs.times(feeFraction)),
  };

  // Called with the already-updated pool so OHLC reflects the post-swap price.
  const intervalDeltas = { volumeToken0: amount0Abs, volumeToken1: amount1Abs, volumeUSD: ZERO_BD, feesUSD: ZERO_BD };
  const poolHourData = updatePoolHourData(pool, intervals.hour, tx.block.timestamp, intervalDeltas);
  const poolDayData = updatePoolDayData(pool, intervals.day, tx.block.timestamp, intervalDeltas);

  const token0 = {
    ...existingToken0,
    volume: existingToken0.volume.plus(amount0Abs),
    totalValueLocked: existingToken0.totalValueLocked.plus(amount0),
    txCount: existingToken0.txCount + 1n,
  };
  const token1 = {
    ...existingToken1,
    volume: existingToken1.volume.plus(amount1Abs),
    totalValueLocked: existingToken1.totalValueLocked.plus(amount1),
    txCount: existingToken1.txCount + 1n,
  };

  const swap: Swap = {
    id: `${tx.chainId}_${tx.block.number}_${args.logIndex}`,
    chainId: BigInt(tx.chainId),
    transaction: tx.hash,
    timestamp: BigInt(tx.block.timestamp),
    pool: poolId,
    token0_id: token0.id,
    token1_id: token1.id,
    sender: args.sender,
    origin: tx.origin,
    amount0,
    amount1,
    amountUSD: ZERO_BD,
    sqrtPriceX96: args.sqrtPriceX96,
    tick: args.tick,
    logIndex: BigInt(args.logIndex),
    fee: args.fee,
  };

  context.Pool.set(pool);
  context.Swap.set(swap);
  context.Token.set(token0);
  context.Token.set(token1);
  context.PoolHourData.set(poolHourData);
  context.PoolDayData.set(poolDayData);
  context.PoolManager.set({
    ...existingPoolManager,
    txCount: existingPoolManager.txCount + 1n,
    numberOfSwaps: existingPoolManager.numberOfSwaps + 1n,
    hookedSwaps: existingPoolManager.hookedSwaps + 1n,
  });
  context.HookStats.set({ ...existingHookStats, numberOfSwaps: existingHookStats.numberOfSwaps + 1n });
  return true;
};
