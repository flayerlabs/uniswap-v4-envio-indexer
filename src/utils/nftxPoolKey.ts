/*
 * Deriving a Uniswap v4 pool id from an NFTX pool's components.
 *
 * Every NFTX pool is `(currency0, currency1, fee, tickSpacing, hooks)` hashed
 * with keccak256 over the abi-encoded struct. Two details make a naive
 * derivation wrong, and both are load-bearing:
 *
 *   1. v4 sorts the pair by address ascending. The collection token is a CREATE2
 *      clone, so whether it lands on currency0 or currency1 is effectively a coin
 *      flip — as of writing, 12 of our 24 pools have the COLLECTION token as
 *      currency0. Assuming "quote token first" would derive the wrong id for half
 *      the book.
 *   2. The hook is part of the key. Canonical pools use NFTXV4Hook; flex pools
 *      (whitelisted pair tokens rather than the chain's quote token) use
 *      NFTXFlexHook, and a flex pool's pair token is not the quote token either.
 *
 * This module is used by the generator and its tests to VALIDATE the ids we take
 * from the NFTX indexer. The indexer records the key straight off
 * `Locker.CollectionInitialized`, so it is the authority; this is the check that
 * catches a bad row rather than the source of truth.
 */
import { encodeAbiParameters, keccak256 } from "viem";

/** v4 pools with a hook-set dynamic fee carry this sentinel in the key. */
export const DYNAMIC_FEE_FLAG = 0x800000;

/** Every NFTX pool is opened at this spacing (NFTXHookCore.POOL_TICK_SPACING). */
export const NFTX_TICK_SPACING = 60;

export interface NftxPoolKeyParts {
  /** The collection's ERC20. Either side of the pair — this function sorts. */
  collectionToken: string;
  /** flETH / USDC on a canonical pool; the whitelisted token on a flex pool. */
  pairToken: string;
  /** NFTXV4Hook for canonical pools, NFTXFlexHook for flex pools. */
  hooks: string;
  fee?: number;
  tickSpacing?: number;
}

/** Sorts the pair the way Uniswap v4 does: by address, ascending. */
export const sortCurrencies = (a: string, b: string): [string, string] => {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return BigInt(left) < BigInt(right) ? [left, right] : [right, left];
};

/** `keccak256(abi.encode(PoolKey))` — the id every v4 event is keyed by. */
export const nftxPoolId = (parts: NftxPoolKeyParts): string => {
  const [currency0, currency1] = sortCurrencies(parts.collectionToken, parts.pairToken);
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [
        currency0 as `0x${string}`,
        currency1 as `0x${string}`,
        parts.fee ?? DYNAMIC_FEE_FLAG,
        parts.tickSpacing ?? NFTX_TICK_SPACING,
        parts.hooks.toLowerCase() as `0x${string}`,
      ],
    ),
  );
};
