/*
 * The inverse of TickMath.getSqrtRatioAtTick.
 *
 * Uniswap's Initialize event carries the opening tick alongside the price; our
 * own pool-creation events (Locker.CollectionInitialized, the flex hook's
 * FlexPoolInitialized) carry only `sqrtPriceX96`, so the tick has to be
 * recovered here.
 *
 * Uniswap defines `getTickAtSqrtRatio` as the greatest tick whose sqrt ratio is
 * still <= the given price. Rather than port the bit-twiddling log2 approximation
 * and have to trust it, this binary-searches the forward function already in the
 * codebase — the definition, applied literally. It costs ~21 calls to
 * getSqrtRatioAtTick, once per pool created, which is nothing at the handful of
 * pools NFTX opens.
 */
import { TickMath } from "./liquidityMath/tickMath";

export const getTickAtSqrtPrice = (sqrtPriceX96: bigint): bigint => {
  if (sqrtPriceX96 < TickMath.MIN_SQRT_RATIO || sqrtPriceX96 >= TickMath.MAX_SQRT_RATIO) {
    throw new Error(`sqrtPriceX96 ${sqrtPriceX96} is outside the tick range`);
  }

  let low = TickMath.MIN_TICK;
  let high = TickMath.MAX_TICK;

  // Invariant: getSqrtRatioAtTick(low) <= sqrtPriceX96, and the answer is in [low, high].
  while (low < high) {
    // Round the midpoint up, so `low = mid` always makes progress on negative ticks.
    const mid = (low + high + 1n) / 2n - ((low + high + 1n) % 2n < 0n ? 1n : 0n);
    if (TickMath.getSqrtRatioAtTick(mid) <= sqrtPriceX96) {
      low = mid;
    } else {
      high = mid - 1n;
    }
  }

  return low;
};
