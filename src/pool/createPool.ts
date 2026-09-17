/*
 * Pool creation from a PoolManager.Initialize log in a replayed receipt.
 *
 * Lifted from the upstream Uniswap `Initialize` handler with the pricing graph
 * removed: no whitelist pools, no derivedETH, no USD. Token metadata is still
 * read once per new token. Only pools on a deployed NFTX hook are admitted, and
 * the check runs before any entity read or RPC.
 */
import { BigDecimal, type Pool } from "envio";
import { getAddress } from "viem";
import { getChainConfig } from "../utils/chains";
import { ZERO_BD } from "../utils/constants";
import { sqrtPriceX96ToTokenPrices } from "../utils/pricing";
import { getTokenMetadata } from "../utils/tokenMetadata";
import { updatePoolDayData, updatePoolHourData } from "../utils/intervalUpdates";
import { isNftxHook } from "../utils/nftxHooks";
import type { HandlerContext, ReplayTransaction } from "./context";

export interface InitializeArgs {
  id: string;
  currency0: string;
  currency1: string;
  fee: bigint;
  tickSpacing: bigint;
  hooks: string;
  sqrtPriceX96: bigint;
  tick: bigint;
}

export const poolEntityId = (chainId: number, poolId: string): string => `${chainId}_${poolId.toLowerCase()}`;

export const poolManagerEntityId = (chainId: number): string =>
  `${chainId}_${getAddress(getChainConfig(chainId as Parameters<typeof getChainConfig>[0]).poolManagerAddress)}`;

/** Returns true when a pool was (or, in preload, will be) created. */
export const createPool = async (
  context: HandlerContext,
  tx: ReplayTransaction,
  args: InitializeArgs,
): Promise<boolean> => {
  // Reject unrelated pools before any entity read or token metadata RPC.
  if (!isNftxHook(tx.chainId, args.hooks)) return false;
  const chainConfig = getChainConfig(tx.chainId);
  if (chainConfig.poolsToSkip.includes(args.id)) return false;

  const poolId = poolEntityId(tx.chainId, args.id);
  // A pool is initialised exactly once on-chain, but a reorg replay or a second
  // trigger in the same transaction must not create it twice.
  if (await context.Pool.get(poolId)) return false;

  const currency0 = getAddress(args.currency0);
  const currency1 = getAddress(args.currency1);
  const hooks = getAddress(args.hooks);
  const poolManagerId = poolManagerEntityId(tx.chainId);

  let poolManager = await context.PoolManager.get(poolManagerId);
  if (!poolManager) {
    poolManager = {
      id: poolManagerId,
      chainId: BigInt(tx.chainId),
      poolCount: 1n,
      txCount: 0n,
      totalVolumeUSD: ZERO_BD,
      totalVolumeETH: ZERO_BD,
      totalFeesUSD: ZERO_BD,
      totalFeesETH: ZERO_BD,
      untrackedVolumeUSD: ZERO_BD,
      totalValueLockedUSD: ZERO_BD,
      totalValueLockedETH: ZERO_BD,
      totalValueLockedUSDUntracked: ZERO_BD,
      totalValueLockedETHUntracked: ZERO_BD,
      owner: getAddress(chainConfig.poolManagerAddress),
      numberOfSwaps: 0n,
      hookedPools: 1n,
      hookedSwaps: 0n,
    };
  } else {
    poolManager = {
      ...poolManager,
      poolCount: poolManager.poolCount + 1n,
      hookedPools: poolManager.hookedPools + 1n,
    };
  }

  const hookStatsId = `${tx.chainId}_${hooks}`;
  let hookStats = await context.HookStats.get(hookStatsId);
  hookStats = hookStats
    ? { ...hookStats, numberOfPools: hookStats.numberOfPools + 1n }
    : {
        id: hookStatsId,
        chainId: BigInt(tx.chainId),
        numberOfPools: 1n,
        numberOfSwaps: 0n,
        firstPoolCreatedAt: BigInt(tx.block.timestamp),
        totalValueLockedUSD: ZERO_BD,
        totalVolumeUSD: ZERO_BD,
        untrackedVolumeUSD: ZERO_BD,
        totalFeesUSD: ZERO_BD,
      };

  const loadToken = async (currency: `0x${string}`) => {
    const tokenId = `${tx.chainId}_${currency.toLowerCase()}`;
    const existing = await context.Token.get(tokenId);
    if (existing) return { ...existing, poolCount: existing.poolCount + 1n };
    const metadata = await context.effect(getTokenMetadata, { address: currency, chainId: tx.chainId });
    return {
      id: tokenId,
      chainId: BigInt(tx.chainId),
      symbol: metadata.symbol,
      name: metadata.name,
      decimals: BigInt(metadata.decimals),
      totalSupply: 0n,
      volume: ZERO_BD,
      volumeUSD: ZERO_BD,
      untrackedVolumeUSD: ZERO_BD,
      feesUSD: ZERO_BD,
      txCount: 0n,
      poolCount: 1n,
      totalValueLocked: ZERO_BD,
      totalValueLockedUSD: ZERO_BD,
      totalValueLockedUSDUntracked: ZERO_BD,
      derivedETH: ZERO_BD,
      whitelistPools: [],
    };
  };
  const [token0, token1] = await Promise.all([loadToken(currency0), loadToken(currency1)]);

  if (context.isPreload) return true;

  const prices = sqrtPriceX96ToTokenPrices(args.sqrtPriceX96, token0, token1, chainConfig.nativeTokenDetails);
  const feeBps = Number(args.fee) / 10000;

  const pool: Pool = {
    id: poolId,
    chainId: BigInt(tx.chainId),
    name: `${token0.symbol} / ${token1.symbol} - ${feeBps}%`,
    createdAtTimestamp: BigInt(tx.block.timestamp),
    createdAtBlockNumber: BigInt(tx.block.number),
    token0: token0.id,
    token1: token1.id,
    feeTier: args.fee,
    liquidity: 0n,
    sqrtPrice: args.sqrtPriceX96,
    token0Price: prices[0],
    token1Price: prices[1],
    tick: args.tick,
    tickSpacing: args.tickSpacing,
    observationIndex: 0n,
    volumeToken0: ZERO_BD,
    volumeToken1: ZERO_BD,
    volumeUSD: ZERO_BD,
    untrackedVolumeUSD: ZERO_BD,
    feesUSD: ZERO_BD,
    feesUSDUntracked: ZERO_BD,
    txCount: 0n,
    collectedFeesToken0: ZERO_BD,
    collectedFeesToken1: ZERO_BD,
    collectedFeesUSD: ZERO_BD,
    totalValueLockedToken0: ZERO_BD,
    totalValueLockedToken1: ZERO_BD,
    totalValueLockedETH: ZERO_BD,
    totalValueLockedUSD: ZERO_BD,
    totalValueLockedUSDUntracked: ZERO_BD,
    liquidityProviderCount: 0n,
    hooks,
  };

  context.Pool.set(pool);
  // Seed the interval buckets at creation, as the upstream subgraph does, so a
  // pool that is initialised and then sits idle still reports its opening price.
  context.PoolHourData.set(updatePoolHourData(pool, undefined, tx.block.timestamp));
  context.PoolDayData.set(updatePoolDayData(pool, undefined, tx.block.timestamp));
  context.PoolManager.set(poolManager);
  context.HookStats.set(hookStats);
  context.Bundle.set({ id: tx.chainId.toString(), ethPriceUSD: new BigDecimal("0") });
  context.Token.set(token0);
  context.Token.set(token1);
  return true;
};
