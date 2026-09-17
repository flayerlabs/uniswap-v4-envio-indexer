/*
 * The only handlers. Each subscribed NFTX event is a trigger: "this transaction
 * touched a pool on one of our hooks". The handler fetches the transaction's
 * receipt (once per transaction, cached) and replays every PoolManager
 * Initialize / ModifyLiquidity / Swap log in it, in log order, admitting only
 * pools on a deployed NFTX hook. Nothing is read from the trigger's own params.
 *
 * Why the receipt and not the trigger: Swap/ModifyLiquidity on the singleton
 * PoolManager carry no hook, so they cannot be subscribed to per hook, and the
 * hook's state event carries the post-state but not the deltas. The receipt has
 * both the deltas and the original hash, log indices and sender.
 *
 * Ordering guarantees the replay relies on:
 *   - every PoolManager action on our pools is followed, in the same
 *     transaction, by a hook state event (afterSwap/afterAdd/afterRemove; the
 *     canonical hook also emits at initialize and flex emits FlexPoolInitialized
 *     from beforeInitialize), so the trigger always exists;
 *   - HyperIndex delivers triggers in (block, logIndex) order, so a receipt is
 *     replayed at its first trigger, before any later transaction's;
 *   - Initialize precedes the seed ModifyLiquidity within a receipt, so the
 *     pool exists before its first deposit and a later CollectionInitialized /
 *     second PoolStateUpdated in the same transaction finds it already indexed.
 */
import { indexer, type EvmOnEventContext } from "envio";
import { getChainConfig } from "../utils/chains";
import { decodePoolManagerLog } from "../utils/poolManagerEvents";
import { getTransactionReceipt, ReceiptMismatchError } from "../utils/transactionReceipt";
import { createPool } from "../pool/createPool";
import { applyModifyLiquidity } from "../pool/modifyLiquidity";
import { applySwap } from "../pool/swap";
import type { IndexedChainId, ReplayTransaction } from "../pool/context";

interface TriggerEvent {
  chainId: IndexedChainId;
  block: { number: number; timestamp: number; hash: string };
  transaction: { hash: string };
  logIndex: number;
  srcAddress: string;
}

const replayTransaction = async (context: EvmOnEventContext, event: TriggerEvent): Promise<void> => {
  const hash = event.transaction.hash.toLowerCase();
  const txId = `${event.chainId}_${hash}`;

  // Several triggers land in one transaction; the first replays it, the rest
  // are no-ops. In the preload pass every trigger reaches the effect, which
  // dedupes on input, so the node is still asked once.
  if (await context.IndexedTransaction.get(txId)) return;

  const receipt = await context.effect(getTransactionReceipt, {
    chainId: event.chainId,
    hash,
    blockNumber: event.block.number,
    blockHash: event.block.hash,
  });

  // The receipt must contain the very log that triggered us, or it is not the
  // receipt of this event's transaction.
  const trigger = receipt.logs.find(
    (log) => log.logIndex === event.logIndex && log.address === event.srcAddress.toLowerCase(),
  );
  if (!trigger) {
    throw new ReceiptMismatchError(
      `receipt for ${hash} on chain ${event.chainId} has no log ${event.logIndex} from ${event.srcAddress}`,
    );
  }

  const tx: ReplayTransaction = {
    chainId: event.chainId,
    hash,
    origin: receipt.from,
    block: { number: event.block.number, timestamp: event.block.timestamp },
  };
  const poolManager = getChainConfig(event.chainId).poolManagerAddress.toLowerCase();

  // Sequential on purpose: a ModifyLiquidity must see the Pool its Initialize
  // created a few logs earlier, and two swaps on one pool compound.
  let applied = 0;
  for (const log of receipt.logs) {
    if (log.address !== poolManager) continue;
    const decoded = decodePoolManagerLog(log);
    if (!decoded) continue;
    switch (decoded.name) {
      case "Initialize":
        if (
          await createPool(context, tx, {
            id: decoded.args.id,
            currency0: decoded.args.currency0,
            currency1: decoded.args.currency1,
            fee: BigInt(decoded.args.fee),
            tickSpacing: BigInt(decoded.args.tickSpacing),
            hooks: decoded.args.hooks,
            sqrtPriceX96: decoded.args.sqrtPriceX96,
            tick: BigInt(decoded.args.tick),
          })
        ) {
          applied++;
        }
        break;
      case "ModifyLiquidity":
        if (
          await applyModifyLiquidity(context, tx, {
            id: decoded.args.id,
            sender: decoded.args.sender,
            tickLower: BigInt(decoded.args.tickLower),
            tickUpper: BigInt(decoded.args.tickUpper),
            liquidityDelta: decoded.args.liquidityDelta,
            logIndex: log.logIndex,
          })
        ) {
          applied++;
        }
        break;
      case "Swap":
        if (
          await applySwap(context, tx, {
            id: decoded.args.id,
            sender: decoded.args.sender,
            amount0: decoded.args.amount0,
            amount1: decoded.args.amount1,
            sqrtPriceX96: decoded.args.sqrtPriceX96,
            liquidity: decoded.args.liquidity,
            tick: BigInt(decoded.args.tick),
            fee: BigInt(decoded.args.fee),
            logIndex: log.logIndex,
          })
        ) {
          applied++;
        }
        break;
    }
  }

  if (context.isPreload) return;
  context.IndexedTransaction.set({
    id: txId,
    chainId: BigInt(event.chainId),
    hash,
    blockNumber: BigInt(event.block.number),
    timestamp: BigInt(event.block.timestamp),
    origin: receipt.from,
    triggerLogIndex: BigInt(event.logIndex),
    poolLogs: BigInt(applied),
  });
};

indexer.onEvent({ contract: "NFTXLocker", event: "CollectionInitialized" }, ({ event, context }) =>
  replayTransaction(context, event),
);
indexer.onEvent({ contract: "NFTXV4Hook", event: "PoolStateUpdated" }, ({ event, context }) =>
  replayTransaction(context, event),
);
indexer.onEvent({ contract: "NFTXFlexHook", event: "FlexPoolInitialized" }, ({ event, context }) =>
  replayTransaction(context, event),
);
indexer.onEvent({ contract: "NFTXFlexHook", event: "FlexPoolStateUpdated" }, ({ event, context }) =>
  replayTransaction(context, event),
);
