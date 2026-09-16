/*
 * NFTX pool creation.
 *
 * Uniswap's own `Initialize` is emitted by the PoolManager singleton, so
 * indexing it meant creating a Pool row and two Token rows — each Token costing
 * an RPC round trip for its metadata — for every v4 pool on every chain. That
 * had grown to ~472k Pool rows and ~255k Token rows to serve NFTX's two dozen
 * pools, and Arc alone was opening ~109k pools a day.
 *
 * Our pools announce themselves on contracts we own, at one address per chain,
 * so we listen to those instead and never see anybody else's:
 *
 *   - `Locker.CollectionInitialized` for canonical pools. It carries the
 *     abi-encoded PoolKey, so currencies, fee, tickSpacing and hooks all come
 *     from the event; the pool id is the keccak of those same bytes.
 *   - `NFTXFlexHook.FlexPoolInitialized` for flex pools, which hands us the pool
 *     id and the decoded key directly.
 *
 * Neither carries the opening tick the way Uniswap's event does, so it is
 * recovered from the price (see getTickAtSqrtPrice).
 */

import { indexer, BigDecimal, type EvmOnEventContext, type Pool } from "envio";
import { getAddress, keccak256 } from "viem";
import { getChainConfig } from "../utils/chains";
import { sqrtPriceX96ToTokenPrices } from "../utils/pricing";
import { getTokenMetadata } from "../utils/tokenMetadata";
import { findNativePerToken } from "../utils/pricing";
import { sanitizeBD } from "../utils";
import { getTickAtSqrtPrice } from "../utils/tickFromSqrtPrice";
import { updatePoolDayData, updatePoolHourData } from "../utils/intervalUpdates";

/** The five static words of an abi-encoded v4 PoolKey. */
interface DecodedPoolKey {
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: bigint;
  tickSpacing: bigint;
  hooks: `0x${string}`;
}

/**
 * `abi.encode(PoolKey)` is five 32-byte words, all static, so the members are
 * fixed offsets — no decoder needed. Mirrors the NFTX indexer's own poolKey
 * reader.
 */
const decodePoolKey = (poolKey: string): DecodedPoolKey => {
  const raw = poolKey.startsWith("0x") ? poolKey.slice(2) : poolKey;
  if (raw.length < 64 * 5) {
    throw new Error(`poolKey is ${raw.length / 2} bytes, expected at least 160`);
  }
  const word = (i: number) => raw.slice(i * 64, (i + 1) * 64);
  const toInt24 = (hex: string): bigint => {
    const value = BigInt(`0x${hex}`);
    // int24 is two's complement in a 256-bit word.
    return value >= 1n << 255n ? value - (1n << 256n) : value;
  };
  // Envio hands addresses to handlers checksummed, and entity ids are built from
  // them, so decode to the same form or ids silently fail to match (a PoolManager
  // keyed on a lowercase address is a different row from the one the Swap handler
  // looks up).
  const address = (w: string) => getAddress(`0x${w.slice(24)}`);
  return {
    currency0: address(word(0)),
    currency1: address(word(1)),
    fee: BigInt(`0x${word(2)}`),
    tickSpacing: toInt24(word(3)),
    hooks: address(word(4)),
  };
};

/** The chains this indexer is configured for; getChainConfig is keyed on them. */
type IndexedChainId = Parameters<typeof getChainConfig>[0];

interface PoolCreationEvent {
  chainId: IndexedChainId;
  block: { number: number; timestamp: number };
}

/**
 * Creates the Pool, its two Tokens and the opening interval buckets. Lifted
 * verbatim from the Uniswap `Initialize` handler this replaces — the only
 * changes are that the key comes from arguments rather than event params, the
 * PoolManager entity is addressed by configured address rather than the event's
 * emitter (which is now our Locker), and the tick is derived.
 */
const createNftxPool = async (
  context: EvmOnEventContext,
  event: PoolCreationEvent,
  poolId: string,
  key: DecodedPoolKey,
  sqrtPriceX96: bigint,
): Promise<void> => {
  const { currency0, currency1, fee, tickSpacing, hooks } = key;
  const chainConfig = getChainConfig(event.chainId);
  const poolManagerAddress = getAddress(chainConfig.poolManagerAddress);
  const poolManagerId = `${event.chainId}_${poolManagerAddress}`;
  const tick = getTickAtSqrtPrice(sqrtPriceX96);

  // Check if this pool should be skipped (similar to subgraph implementation)
  if (chainConfig.poolsToSkip.includes(poolId)) {
    return;
  }

  // Define isHookedPool at the start
  const isHookedPool =
    hooks !== "0x0000000000000000000000000000000000000000";

  let poolManager = await context.PoolManager.get(
    poolManagerId
  );
  if (!poolManager) {
    poolManager = {
      id: poolManagerId,
      chainId: BigInt(event.chainId),
      poolCount: 1n,
      txCount: 0n,
      totalVolumeUSD: new BigDecimal(0),
      totalVolumeETH: new BigDecimal(0),
      totalFeesUSD: new BigDecimal(0),
      totalFeesETH: new BigDecimal(0),
      untrackedVolumeUSD: new BigDecimal(0),
      totalValueLockedUSD: new BigDecimal(0),
      totalValueLockedETH: new BigDecimal(0),
      totalValueLockedUSDUntracked: new BigDecimal(0),
      totalValueLockedETHUntracked: new BigDecimal(0),
      owner: poolManagerAddress,
      numberOfSwaps: 0n,
      hookedPools: 0n,
      hookedSwaps: 0n,
    };
    context.Bundle.set({
      id: event.chainId.toString(),
      ethPriceUSD: new BigDecimal("0"),
    });
  } else {
    poolManager = {
      ...poolManager,
      poolCount: poolManager.poolCount + 1n,
    };
  }

  // Update or create HookStats if this is a hooked pool
  if (isHookedPool) {
    poolManager = {
      ...poolManager,
      hookedPools: poolManager.hookedPools + 1n,
    };

    const hookStatsId = `${event.chainId}_${hooks}`;
    let hookStats = await context.HookStats.get(hookStatsId);

    if (!hookStats) {
      hookStats = {
        id: hookStatsId,
        chainId: BigInt(event.chainId),
        numberOfPools: 0n,
        numberOfSwaps: 0n,
        firstPoolCreatedAt: BigInt(event.block.timestamp),
        totalValueLockedUSD: new BigDecimal("0"),
        totalVolumeUSD: new BigDecimal("0"),
        untrackedVolumeUSD: new BigDecimal("0"),
        totalFeesUSD: new BigDecimal("0"),
      };
    }

    hookStats = {
      ...hookStats,
      numberOfPools: hookStats.numberOfPools + 1n,
    };

    context.HookStats.set(hookStats);
  }

  // Create or get token0
  const token0Id = `${event.chainId}_${currency0.toLowerCase()}`;
  let token0 = await context.Token.get(token0Id);
  if (!token0) {
    const metadata = await context.effect(getTokenMetadata, {
      address: currency0,
      chainId: event.chainId,
    });
    token0 = {
      id: token0Id,
      chainId: BigInt(event.chainId),
      symbol: metadata.symbol,
      name: metadata.name,
      decimals: BigInt(metadata.decimals),
      totalSupply: 0n,
      volume: new BigDecimal("0"),
      volumeUSD: new BigDecimal("0"),
      untrackedVolumeUSD: new BigDecimal("0"),
      feesUSD: new BigDecimal("0"),
      txCount: 0n,
      poolCount: 1n,
      totalValueLocked: new BigDecimal("0"),
      totalValueLockedUSD: new BigDecimal("0"),
      totalValueLockedUSDUntracked: new BigDecimal("0"),
      derivedETH: new BigDecimal("0"),
      whitelistPools: [], // Initialize empty array
    };
  } else {
    token0 = {
      ...token0,
      poolCount: token0.poolCount + 1n,
    };
  }

  // Create or get token1
  const token1Id = `${event.chainId}_${currency1.toLowerCase()}`;
  let token1 = await context.Token.get(token1Id);
  if (!token1) {
    const metadata = await context.effect(getTokenMetadata, {
      address: currency1,
      chainId: event.chainId,
    });
    token1 = {
      id: token1Id,
      chainId: BigInt(event.chainId),
      symbol: metadata.symbol,
      name: metadata.name,
      decimals: BigInt(metadata.decimals),
      totalSupply: 0n,
      volume: new BigDecimal("0"),
      volumeUSD: new BigDecimal("0"),
      untrackedVolumeUSD: new BigDecimal("0"),
      feesUSD: new BigDecimal("0"),
      txCount: 0n,
      poolCount: 1n,
      totalValueLocked: new BigDecimal("0"),
      totalValueLockedUSD: new BigDecimal("0"),
      totalValueLockedUSDUntracked: new BigDecimal("0"),
      derivedETH: new BigDecimal("0"),
      whitelistPools: [], // Initialize empty array
    };
  } else {
    token1 = {
      ...token1,
      poolCount: token1.poolCount + 1n,
    };
  }

  // Update whitelist pools first
  if (
    chainConfig.whitelistTokens.includes(currency0.toLowerCase())
  ) {
    token1 = {
      ...token1,
      whitelistPools: [
        ...token1.whitelistPools,
        `${event.chainId}_${poolId}`,
      ],
    };
  }

  if (
    chainConfig.whitelistTokens.includes(currency1.toLowerCase())
  ) {
    token0 = {
      ...token0,
      whitelistPools: [
        ...token0.whitelistPools,
        `${event.chainId}_${poolId}`,
      ],
    };
  }

  // Now update derivedETH values
  token0 = {
    ...token0,
    derivedETH: sanitizeBD(
      await findNativePerToken(
        context,
        token0,
        chainConfig.wrappedNativeAddress,
        chainConfig.stablecoinAddresses,
        chainConfig.minimumNativeLocked
      )
    ),
  };

  token1 = {
    ...token1,
    derivedETH: sanitizeBD(
      await findNativePerToken(
        context,
        token1,
        chainConfig.wrappedNativeAddress,
        chainConfig.stablecoinAddresses,
        chainConfig.minimumNativeLocked
      )
    ),
  };

  if (context.isPreload) {
    return;
  }

  // Calculate initial prices
  const prices = sqrtPriceX96ToTokenPrices(
    sqrtPriceX96,
    token0,
    token1,
    chainConfig.nativeTokenDetails
  );

  const feeBps = Number(fee) / 10000; // Convert to percentage (fee is in bps)
  const poolName = `${token0.symbol} / ${token1.symbol} - ${feeBps}%`;

  // Create new pool with prices
  const pool: Pool = {
    id: `${event.chainId}_${poolId}`,
    chainId: BigInt(event.chainId),
    name: poolName,
    createdAtTimestamp: BigInt(event.block.timestamp),
    createdAtBlockNumber: BigInt(event.block.number),
    token0: token0Id,
    token1: token1Id,
    feeTier: BigInt(fee),
    liquidity: 0n,
    sqrtPrice: sqrtPriceX96,
    token0Price: prices[0],
    token1Price: prices[1],
    tick: tick,
    tickSpacing: BigInt(tickSpacing),
    observationIndex: 0n,
    volumeToken0: new BigDecimal(0),
    volumeToken1: new BigDecimal(0),
    volumeUSD: new BigDecimal(0),
    untrackedVolumeUSD: new BigDecimal(0),
    feesUSD: new BigDecimal("0"),
    feesUSDUntracked: new BigDecimal("0"),
    txCount: 0n,
    collectedFeesToken0: new BigDecimal(0),
    collectedFeesToken1: new BigDecimal(0),
    collectedFeesUSD: new BigDecimal(0),
    totalValueLockedToken0: new BigDecimal(0),
    totalValueLockedToken1: new BigDecimal(0),
    totalValueLockedETH: new BigDecimal(0),
    totalValueLockedUSD: new BigDecimal(0),
    totalValueLockedUSDUntracked: new BigDecimal(0),
    liquidityProviderCount: 0n,
    hooks: hooks,
  };
  context.Pool.set(pool);

  // Seed the interval buckets at pool creation, as the upstream subgraph does,
  // so a pool that is initialised and then sits idle still reports its opening
  // price for that hour/day. A pool is initialised exactly once, so there is
  // never an existing bucket to merge into and nothing has to be read here.
  context.PoolHourData.set(updatePoolHourData(pool, undefined, event.block.timestamp));
  context.PoolDayData.set(updatePoolDayData(pool, undefined, event.block.timestamp));

  context.PoolManager.set(poolManager);
  context.Token.set(token0);
  context.Token.set(token1);
};

indexer.onEvent(
  { contract: "NFTXLocker", event: "CollectionInitialized" },
  async ({ event, context }) => {
    // The pool id is the keccak of the very bytes the Locker emitted.
    const poolId = keccak256(event.params._poolKey as `0x${string}`);
    await createNftxPool(
      context,
      event,
      poolId,
      decodePoolKey(event.params._poolKey),
      event.params._sqrtPriceX96,
    );
  },
);

indexer.onEvent(
  { contract: "NFTXFlexHook", event: "FlexPoolInitialized" },
  async ({ event, context }) => {
    // The key arrives as a positional tuple object, not an array.
    const key = event.params._key;
    const [currency0, currency1, fee, tickSpacing, hooks] = [
      key[0],
      key[1],
      key[2],
      key[3],
      key[4],
    ];
    await createNftxPool(
      context,
      event,
      event.params._poolId,
      {
        currency0: getAddress(currency0),
        currency1: getAddress(currency1),
        fee: BigInt(fee),
        tickSpacing: BigInt(tickSpacing),
        hooks: getAddress(hooks),
      },
      event.params._sqrtPriceX96,
    );
  },
);
