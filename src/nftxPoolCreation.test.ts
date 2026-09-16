import { describe, expect, it } from "vitest";
import { keccak256 } from "viem";
import { TickMath } from "./utils/liquidityMath/tickMath";
import { getTickAtSqrtPrice } from "./utils/tickFromSqrtPrice";

/**
 * Pools are created from our own Locker / flex-hook events rather than Uniswap's
 * Initialize, which means two things have to be recovered here that the Uniswap
 * event used to hand over: the pool id (keccak of the emitted key) and the
 * opening tick (derived from the price).
 */

// NFTX pool 0x0e6609… on Ethereum mainnet, as recorded by the NFTX indexer from
// Locker.CollectionInitialized at block 25691611.
const REAL_POOL_KEY =
  "0x000000000000000000000000000000000bb1f9944965c64066d10038a84f9af2" +
  "000000000000000000000000188b1eda9982384a9e3acc7a729415825618900b" +
  "0000000000000000000000000000000000000000000000000000000000800000" +
  "000000000000000000000000000000000000000000000000000000000000003c" +
  "000000000000000000000000aa49adadd33c5e953b645567afb10cbbba63afc4";
const REAL_POOL_ID = "0x0e660964910a5c4af75309dba8f547a5a4303ac416a3ea54c1a3388cc5f32c91";
const REAL_SQRT_PRICE = 15193929545511584087699463256n;

describe("pool id from the emitted key", () => {
  it("is the keccak of the bytes the Locker emitted", () => {
    expect(keccak256(REAL_POOL_KEY as `0x${string}`)).toBe(REAL_POOL_ID);
  });

  it("reads the key's five static words at fixed offsets", () => {
    const raw = REAL_POOL_KEY.slice(2);
    const word = (i: number) => raw.slice(i * 64, (i + 1) * 64);
    expect(`0x${word(0).slice(24)}`).toBe("0x000000000bb1f9944965c64066d10038a84f9af2"); // flETH
    expect(`0x${word(1).slice(24)}`).toBe("0x188b1eda9982384a9e3acc7a729415825618900b"); // collection token
    expect(BigInt(`0x${word(2)}`)).toBe(0x800000n); // dynamic-fee sentinel
    expect(BigInt(`0x${word(3)}`)).toBe(60n); // tick spacing
    expect(`0x${word(4).slice(24)}`).toBe("0xaa49adadd33c5e953b645567afb10cbbba63afc4"); // NFTXV4Hook
  });
});

describe("recovering the opening tick", () => {
  it("round-trips every tick that sits exactly on a sqrt ratio", () => {
    for (const tick of [0n, 1n, -1n, 60n, -60n, 887220n, -887220n, 195_000n, -195_000n]) {
      expect(getTickAtSqrtPrice(TickMath.getSqrtRatioAtTick(tick))).toBe(tick);
    }
  });

  it("returns the greatest tick at or below the price, as Uniswap defines it", () => {
    for (const tick of [0n, 60n, -60n, 12_345n, -12_345n]) {
      const exact = TickMath.getSqrtRatioAtTick(tick);
      // A hair above the boundary still belongs to the same tick...
      expect(getTickAtSqrtPrice(exact + 1n)).toBe(tick);
      // ...and a hair below belongs to the one under it.
      expect(getTickAtSqrtPrice(exact - 1n)).toBe(tick - 1n);
    }
  });

  it("recovers a real pool's opening tick and agrees with the forward function", () => {
    const tick = getTickAtSqrtPrice(REAL_SQRT_PRICE);
    expect(TickMath.getSqrtRatioAtTick(tick)).toBeLessThanOrEqual(REAL_SQRT_PRICE);
    expect(TickMath.getSqrtRatioAtTick(tick + 1n)).toBeGreaterThan(REAL_SQRT_PRICE);
  });

  it("refuses a price outside the representable range", () => {
    expect(() => getTickAtSqrtPrice(TickMath.MIN_SQRT_RATIO - 1n)).toThrow(/outside the tick range/);
    expect(() => getTickAtSqrtPrice(TickMath.MAX_SQRT_RATIO)).toThrow(/outside the tick range/);
  });
});
