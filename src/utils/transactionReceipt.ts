/*
 * The one external read the indexer makes per NFTX transaction.
 *
 * A subscribed hook/Locker event says "this transaction touched one of our
 * pools"; the receipt says what it did. The effect fetches the receipt over RPC,
 * checks it is the receipt of the block the event came from, and keeps only the
 * logs the replay needs: every PoolManager log, plus the subscribed NFTX logs
 * so the handler can confirm its own trigger is in there.
 *
 * Failure policy, in order:
 *   - transport errors (429, 5xx, timeouts): viem retries on the client
 *     (METADATA_RPC_RETRY, ~63s of backoff);
 *   - receipt missing, or for another block (the RPC is behind HyperSync, or on
 *     the other side of a reorg): retried here with backoff;
 *   - still wrong after that, or a reverted transaction: throw. HyperIndex does
 *     not retry effects — a throw halts the chain, which is the intent: a
 *     transaction we know touched our pools must never be silently skipped.
 *     `context.cache` is cleared first so the next attempt after a restart
 *     fetches again instead of replaying the failure.
 */
import { createEffect, S } from "envio";
import { getAddress, type Hash } from "viem";
import { getRpcClient } from "./tokenMetadata";
import { getChainConfig } from "./chains";
import { NFTX_EVENT_BY_TOPIC } from "./nftxEvents";

const ReceiptLogSchema = S.schema({
  logIndex: S.number,
  address: S.string,
  topics: S.array(S.string),
  data: S.string,
});

const ReceiptSummarySchema = S.schema({
  hash: S.string,
  blockNumber: S.number,
  blockHash: S.string,
  transactionIndex: S.number,
  /** Checksummed `from` — the EOA every Swap/ModifyLiquidity in the tx is attributed to. */
  from: S.string,
  status: S.union(["success", "reverted"]),
  /** Total logs in the receipt, before trimming. */
  logCount: S.number,
  /** PoolManager logs plus the subscribed NFTX logs, in log-index order. */
  logs: S.array(ReceiptLogSchema),
});

export type ReceiptSummary = S.Output<typeof ReceiptSummarySchema>;

export interface ReceiptRequest {
  chainId: number;
  hash: string;
  /** The block the triggering event was observed in. The receipt must agree. */
  blockNumber: number;
  blockHash: string;
}

/** A raw receipt, as much of it as the trim reads. */
export interface RawReceipt {
  transactionHash: string;
  blockNumber: bigint | number;
  blockHash: string;
  transactionIndex: number;
  from: string;
  status: "success" | "reverted";
  logs: ReadonlyArray<{ logIndex: number; address: string; topics: readonly string[]; data: string }>;
}

/** Returns the receipt, or `null` when the node does not have it (yet). */
export type ReceiptSource = (request: ReceiptRequest) => Promise<RawReceipt | null>;

export const RECEIPT_RETRY = {
  /** Attempts before a missing/mismatched receipt is fatal. */
  attempts: 5,
  /** First backoff; doubles per attempt (1+2+4+8 = 15s in total). */
  delayMs: 1_000,
} as const;

export class ReceiptMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptMismatchError";
  }
}

const rpcReceiptSource: ReceiptSource = async ({ chainId, hash }) => {
  const client = getRpcClient(chainId);
  try {
    return await client.getTransactionReceipt({ hash: hash as Hash });
  } catch (error) {
    // viem raises rather than returning null for an unknown hash.
    if ((error as { name?: string }).name === "TransactionReceiptNotFoundError") return null;
    throw error;
  }
};

type ReceiptSourceOverride = { source: ReceiptSource; retry: { attempts: number; delayMs: number } };

/**
 * Test seam. Simulated events have no chain behind them, so tests install a
 * source that serves stored receipts (and counts the calls), optionally with a
 * shorter retry policy. `undefined` restores the RPC source and RECEIPT_RETRY.
 *
 * It lives on `globalThis`, not in module state: HyperIndex loads the handler
 * modules through its own loader, so under vitest the test file and the
 * handler hold two separate instances of this module, and a module-level
 * variable set by one is invisible to the other.
 */
const seam = globalThis as { __nftxReceiptSource?: ReceiptSourceOverride };

export const setReceiptSource = (
  source: ReceiptSource | undefined,
  retry: { attempts: number; delayMs: number } = RECEIPT_RETRY,
): void => {
  seam.__nftxReceiptSource = source ? { source, retry } : undefined;
};

/**
 * Keeps the logs the replay reads. PoolManager logs by address (the only
 * address the accounting matches on); NFTX logs by topic so the trimmed
 * receipt is address-agnostic and the handler can still find its trigger.
 */
export const trimReceipt = (chainId: number, receipt: RawReceipt): ReceiptSummary => {
  const poolManager = getChainConfig(chainId as Parameters<typeof getChainConfig>[0]).poolManagerAddress.toLowerCase();
  const logs = receipt.logs
    .filter((log) => {
      if (log.address.toLowerCase() === poolManager) return true;
      const topic0 = log.topics[0]?.toLowerCase();
      return topic0 !== undefined && NFTX_EVENT_BY_TOPIC.has(topic0);
    })
    .map((log) => ({
      logIndex: log.logIndex,
      address: log.address.toLowerCase(),
      topics: log.topics.map((topic) => topic.toLowerCase()),
      data: log.data,
    }))
    .sort((a, b) => a.logIndex - b.logIndex);
  return {
    hash: receipt.transactionHash.toLowerCase(),
    blockNumber: Number(receipt.blockNumber),
    blockHash: receipt.blockHash.toLowerCase(),
    transactionIndex: receipt.transactionIndex,
    from: getAddress(receipt.from),
    status: receipt.status,
    logCount: receipt.logs.length,
    logs,
  };
};

/**
 * Fetches and validates a receipt, retrying while the node has no receipt or a
 * receipt for a different block. Exported so the retry policy is unit-testable
 * without HyperIndex in the loop.
 */
export const fetchReceiptSummary = async (
  request: ReceiptRequest,
  source: ReceiptSource,
  retry: { attempts: number; delayMs: number; sleep?: (ms: number) => Promise<void> } = RECEIPT_RETRY,
): Promise<ReceiptSummary> => {
  const sleep = retry.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastProblem = "no attempts made";
  for (let attempt = 0; attempt < retry.attempts; attempt++) {
    if (attempt > 0) await sleep(retry.delayMs * 2 ** (attempt - 1));
    const receipt = await source(request);
    if (!receipt) {
      lastProblem = "the node returned no receipt";
      continue;
    }
    if (Number(receipt.blockNumber) !== request.blockNumber || receipt.blockHash.toLowerCase() !== request.blockHash.toLowerCase()) {
      lastProblem = `receipt is for block ${Number(receipt.blockNumber)} ${receipt.blockHash}, event was observed in block ${request.blockNumber} ${request.blockHash}`;
      continue;
    }
    if (receipt.transactionHash.toLowerCase() !== request.hash.toLowerCase()) {
      throw new ReceiptMismatchError(`asked for ${request.hash}, node returned ${receipt.transactionHash}`);
    }
    if (receipt.status !== "success") {
      // A reverted transaction emits no logs, so it cannot have triggered us.
      throw new ReceiptMismatchError(`transaction ${request.hash} is reverted but emitted a subscribed event`);
    }
    return trimReceipt(request.chainId, receipt);
  }
  throw new ReceiptMismatchError(
    `receipt for ${request.hash} on chain ${request.chainId} unusable after ${retry.attempts} attempts: ${lastProblem}`,
  );
};

export const getTransactionReceipt = createEffect(
  {
    name: "getTransactionReceipt",
    // blockHash is part of the key so a transaction re-included after a reorg
    // is fetched afresh rather than served its pre-reorg receipt.
    input: S.schema({ chainId: S.number, hash: S.string, blockNumber: S.number, blockHash: S.string }),
    output: ReceiptSummarySchema,
    rateLimit: { calls: 5, per: "second" },
    cache: true,
  },
  async ({ input, context }) => {
    try {
      const override = seam.__nftxReceiptSource;
      if (override) {
        // Test seam in use: every test indexer must hit its own source, so
        // nothing served here may outlive the call.
        context.cache = false;
        return await fetchReceiptSummary(input, override.source, override.retry);
      }
      return await fetchReceiptSummary(input, rpcReceiptSource);
    } catch (error) {
      // Never persist a failure: the next run must try the node again.
      context.cache = false;
      context.log.error(`Receipt for ${input.hash} on chain ${input.chainId} could not be replayed`, error as Error);
      throw error;
    }
  },
);
