/*
 * Liquidity accounting for a PoolManager.ModifyLiquidity log in a replayed
 * receipt. Ported from the upstream handler; USD/ETH valuation removed.
 */
import { getAmount0, getAmount1 } from "../utils/liquidityMath/liquidityAmounts";
import { convertTokenToDecimal } from "../utils";
import { ZERO_BD } from "../utils/constants";
import { createInitialTick } from "../utils/tick";
import { getChainConfig } from "../utils/chains";
import { loadPoolIntervals, updatePoolDayData, updatePoolHourData } from "../utils/intervalUpdates";
import type { HandlerContext, ReplayTransaction } from "./context";
import { poolEntityId, poolManagerEntityId } from "./createPool";

export interface ModifyLiquidityArgs {
  id: string;
  sender: string;
  tickLower: bigint;
  tickUpper: bigint;
  liquidityDelta: bigint;
  logIndex: number;
}

/** Returns true when the log was on an NFTX pool and was applied. */
export const applyModifyLiquidity = async (
  context: HandlerContext,
  tx: ReplayTransaction,
  args: ModifyLiquidityArgs,
): Promise<boolean> => {
  if (getChainConfig(tx.chainId).poolsToSkip.includes(args.id)) return false;

  // Pools are created from Initialize earlier in the same receipt or in an
  // earlier transaction; anything else on the PoolManager is not ours.
  const poolId = poolEntityId(tx.chainId, args.id);
  const existingPool = await context.Pool.get(poolId);
  if (!existingPool) return false;

  const lowerTickId = `${poolId}#${args.tickLower}`;
  const upperTickId = `${poolId}#${args.tickUpper}`;

  // HookStats is not touched here: its only per-deposit field was USD TVL.
  const [existingLowerTick, existingUpperTick, existingToken0, existingToken1, existingPoolManager, intervals] =
    await Promise.all([
      context.Tick.get(lowerTickId),
      context.Tick.get(upperTickId),
      context.Token.get(existingPool.token0),
      context.Token.get(existingPool.token1),
      context.PoolManager.get(poolManagerEntityId(tx.chainId)),
      loadPoolIntervals(context, poolId, tx.block.timestamp),
    ]);
  if (context.isPreload) return true;
  if (!existingToken0 || !existingToken1 || !existingPoolManager) {
    throw new Error(`Pool ${poolId} exists without its tokens or PoolManager row`);
  }

  // --- Tick updates ---
  const amount = args.liquidityDelta;
  let lowerTick =
    existingLowerTick ??
    createInitialTick(lowerTickId, Number(args.tickLower), poolId, BigInt(tx.chainId), BigInt(tx.block.timestamp), BigInt(tx.block.number));
  let upperTick =
    existingUpperTick ??
    createInitialTick(upperTickId, Number(args.tickUpper), poolId, BigInt(tx.chainId), BigInt(tx.block.timestamp), BigInt(tx.block.number));
  lowerTick = { ...lowerTick, liquidityGross: lowerTick.liquidityGross + amount, liquidityNet: lowerTick.liquidityNet + amount };
  upperTick = { ...upperTick, liquidityGross: upperTick.liquidityGross + amount, liquidityNet: upperTick.liquidityNet - amount };
  context.Tick.set(lowerTick);
  context.Tick.set(upperTick);

  // --- Pool, token, and manager updates ---
  const currTick = existingPool.tick ?? 0n;
  const currSqrtPriceX96 = existingPool.sqrtPrice ?? 0n;
  const amount0 = convertTokenToDecimal(
    getAmount0(args.tickLower, args.tickUpper, currTick, args.liquidityDelta, currSqrtPriceX96),
    existingToken0.decimals,
  );
  const amount1 = convertTokenToDecimal(
    getAmount1(args.tickLower, args.tickUpper, currTick, args.liquidityDelta, currSqrtPriceX96),
    existingToken1.decimals,
  );

  let pool = {
    ...existingPool,
    txCount: existingPool.txCount + 1n,
    totalValueLockedToken0: existingPool.totalValueLockedToken0.plus(amount0),
    totalValueLockedToken1: existingPool.totalValueLockedToken1.plus(amount1),
  };
  // Only in-range positions change the pool's active liquidity.
  if (pool.tick !== null && pool.tick !== undefined && args.tickLower <= pool.tick && args.tickUpper > pool.tick) {
    pool = { ...pool, liquidity: pool.liquidity + args.liquidityDelta };
  }

  const token0 = {
    ...existingToken0,
    txCount: existingToken0.txCount + 1n,
    totalValueLocked: existingToken0.totalValueLocked.plus(amount0),
  };
  const token1 = {
    ...existingToken1,
    txCount: existingToken1.txCount + 1n,
    totalValueLocked: existingToken1.totalValueLocked.plus(amount1),
  };

  // A liquidity change carries no volume: the buckets take the end-of-period
  // snapshot and a txCount bump, the upstream modifyLiquidity call shape.
  const poolHourData = updatePoolHourData(pool, intervals.hour, tx.block.timestamp);
  const poolDayData = updatePoolDayData(pool, intervals.day, tx.block.timestamp);

  context.ModifyLiquidity.set({
    id: `${tx.chainId}_${tx.hash}_${args.logIndex}`,
    chainId: BigInt(tx.chainId),
    transaction: tx.hash,
    timestamp: BigInt(tx.block.timestamp),
    pool_id: pool.id,
    token0_id: token0.id,
    token1_id: token1.id,
    sender: args.sender,
    origin: tx.origin,
    amount: args.liquidityDelta,
    amount0,
    amount1,
    amountUSD: ZERO_BD,
    tickLower: args.tickLower,
    tickUpper: args.tickUpper,
    logIndex: BigInt(args.logIndex),
  });
  context.PoolManager.set({ ...existingPoolManager, txCount: existingPoolManager.txCount + 1n });
  context.Pool.set(pool);
  context.Token.set(token0);
  context.Token.set(token1);
  context.PoolHourData.set(poolHourData);
  context.PoolDayData.set(poolDayData);
  return true;
};
