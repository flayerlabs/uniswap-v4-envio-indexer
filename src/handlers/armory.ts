/*
 * ApeChain: NFTX collections trade on Armory, a Uniswap V3 fork, not a V4
 * PoolManager. See src/utils/armory.ts for why these pools are subscribed
 * directly instead of being replayed from NFTX receipts.
 *
 * NFTXArmory.MarketRegistered (emitted by Locker.createCollection) registers the
 * collection's deterministic pool as a dynamic ArmoryV3Pool contract and records
 * its token pair. Every later pool log is then indexed, whoever sent it, and is
 * normalised into the same Pool / Swap / ModifyLiquidity / Tick accounting the
 * V4 replay writes:
 *   - Initialize creates the Pool row, with NFTXArmory as its `hooks`;
 *   - Swap amounts are pool-side in V3 (positive = the pool received), so they
 *     are negated into the V4 caller-side convention `applySwap` expects, and
 *     the fee is the pool's fixed tier;
 *   - Mint and Burn become liquidity deltas of +amount and -amount. A zero Burn
 *     is the position manager poking fee growth before a collect, not a change.
 * Collect, Flash and protocol-fee logs are not applied, matching the V4 replay,
 * which also never subtracts collected fees from reserves.
 */
import { indexer, type EvmOnEventContext } from "envio";
import { getAddress } from "viem";
import { armoryPoolId, computeArmoryPool, getArmoryConfig, sortTokens } from "../utils/armory";
import { getArmoryPoolState } from "../utils/armoryPoolState";
import { createPool, poolEntityId } from "../pool/createPool";
import { applyModifyLiquidity } from "../pool/modifyLiquidity";
import { applySwap } from "../pool/swap";
import type { IndexedChainId, ReplayTransaction } from "../pool/context";

interface PoolEvent {
  chainId: IndexedChainId;
  srcAddress: string;
  logIndex: number;
  block: { number: number; timestamp: number };
  transaction: { hash: string; from?: string };
}

const registrationId = (chainId: number, pool: string): string => `${chainId}_${pool.toLowerCase()}`;

const transactionOf = (event: PoolEvent): ReplayTransaction => ({
  chainId: event.chainId,
  hash: event.transaction.hash.toLowerCase(),
  origin: event.transaction.from ? getAddress(event.transaction.from) : "",
  block: { number: event.block.number, timestamp: event.block.timestamp },
});

/**
 * Returns the pool id when the log comes from a registered NFTX pool, creating
 * the Pool row first for a pool that was initialised before its registration.
 */
const resolvePool = async (context: EvmOnEventContext, event: PoolEvent, tx: ReplayTransaction): Promise<string | undefined> => {
  const pool = event.srcAddress.toLowerCase();
  const registration = await context.ArmoryPool.get(registrationId(event.chainId, pool));
  if (!registration) return undefined;

  const id = armoryPoolId(pool);
  if (await context.Pool.get(poolEntityId(event.chainId, id))) return id;

  // Initialised before NFTX registered the collection: read the price the pool
  // held going into this block, which is the state this log was applied to.
  const state = await context.effect(getArmoryPoolState, {
    chainId: event.chainId,
    pool: getAddress(pool),
    blockNumber: event.block.number - 1,
  });
  const config = getArmoryConfig(event.chainId);
  await createPool(context, tx, {
    id,
    currency0: registration.token0,
    currency1: registration.token1,
    fee: config.fee,
    tickSpacing: config.tickSpacing,
    hooks: config.market,
    sqrtPriceX96: state.sqrtPriceX96,
    tick: state.tick,
  });
  return id;
};

indexer.contractRegister({ contract: "NFTXArmory", event: "MarketRegistered" }, async ({ event, context }) => {
  context.chain.ArmoryV3Pool.add(getAddress(computeArmoryPool(event.chainId, event.params._token)));
});

indexer.onEvent({ contract: "NFTXArmory", event: "MarketRegistered" }, async ({ event, context }) => {
  const pool = computeArmoryPool(event.chainId, event.params._token);
  const [token0, token1] = sortTokens(event.chainId, event.params._token);
  context.ArmoryPool.set({
    id: registrationId(event.chainId, pool),
    chainId: BigInt(event.chainId),
    pool,
    poolId: armoryPoolId(pool),
    collection: event.params._collection.toLowerCase(),
    collectionToken: event.params._token.toLowerCase(),
    token0,
    token1,
    registeredAtBlock: BigInt(event.block.number),
  });
});

indexer.onEvent({ contract: "ArmoryV3Pool", event: "Initialize" }, async ({ event, context }) => {
  const pool = event.srcAddress.toLowerCase();
  const registration = await context.ArmoryPool.get(registrationId(event.chainId, pool));
  if (!registration) return;
  const config = getArmoryConfig(event.chainId);
  await createPool(context, transactionOf(event), {
    id: armoryPoolId(pool),
    currency0: registration.token0,
    currency1: registration.token1,
    fee: config.fee,
    tickSpacing: config.tickSpacing,
    hooks: config.market,
    sqrtPriceX96: event.params.sqrtPriceX96,
    tick: event.params.tick,
  });
});

indexer.onEvent({ contract: "ArmoryV3Pool", event: "Swap" }, async ({ event, context }) => {
  const tx = transactionOf(event);
  const id = await resolvePool(context, event, tx);
  if (!id) return;
  await applySwap(context, tx, {
    id,
    sender: event.params.sender,
    // V3 reports pool-side deltas; applySwap takes V4's caller-side ones.
    amount0: -event.params.amount0,
    amount1: -event.params.amount1,
    sqrtPriceX96: event.params.sqrtPriceX96,
    liquidity: event.params.liquidity,
    tick: event.params.tick,
    fee: getArmoryConfig(event.chainId).fee,
    logIndex: event.logIndex,
  });
});

indexer.onEvent({ contract: "ArmoryV3Pool", event: "Mint" }, async ({ event, context }) => {
  const tx = transactionOf(event);
  const id = await resolvePool(context, event, tx);
  if (!id) return;
  await applyModifyLiquidity(context, tx, {
    id,
    sender: event.params.sender,
    tickLower: event.params.tickLower,
    tickUpper: event.params.tickUpper,
    liquidityDelta: event.params.amount,
    logIndex: event.logIndex,
  });
});

indexer.onEvent({ contract: "ArmoryV3Pool", event: "Burn" }, async ({ event, context }) => {
  // A zero burn only refreshes fee growth for a following collect.
  if (event.params.amount === 0n) return;
  const tx = transactionOf(event);
  const id = await resolvePool(context, event, tx);
  if (!id) return;
  await applyModifyLiquidity(context, tx, {
    id,
    sender: event.params.owner,
    tickLower: event.params.tickLower,
    tickUpper: event.params.tickUpper,
    liquidityDelta: -event.params.amount,
    logIndex: event.logIndex,
  });
});
