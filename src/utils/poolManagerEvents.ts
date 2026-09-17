/*
 * The three PoolManager events the receipt replay applies. The PoolManager is
 * not a subscribed contract any more — its logs are read out of the receipts of
 * transactions our hooks emitted into — so the ABI lives here rather than in
 * config.yaml, and the topic selectors are derived from it rather than typed.
 */
import { decodeEventLog, toEventSelector, type Hex } from "viem";

export const POOL_MANAGER_EVENTS_ABI = [
  {
    type: "event",
    name: "Initialize",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "currency0", type: "address", indexed: true },
      { name: "currency1", type: "address", indexed: true },
      { name: "fee", type: "uint24", indexed: false },
      { name: "tickSpacing", type: "int24", indexed: false },
      { name: "hooks", type: "address", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "tick", type: "int24", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ModifyLiquidity",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "tickLower", type: "int24", indexed: false },
      { name: "tickUpper", type: "int24", indexed: false },
      { name: "liquidityDelta", type: "int256", indexed: false },
      { name: "salt", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Swap",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "amount0", type: "int128", indexed: false },
      { name: "amount1", type: "int128", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "liquidity", type: "uint128", indexed: false },
      { name: "tick", type: "int24", indexed: false },
      { name: "fee", type: "uint24", indexed: false },
    ],
  },
] as const;

/** topic0 of each event above, keyed by name. */
export const POOL_MANAGER_TOPICS: Readonly<Record<"Initialize" | "ModifyLiquidity" | "Swap", Hex>> = {
  Initialize: toEventSelector(POOL_MANAGER_EVENTS_ABI[0]),
  ModifyLiquidity: toEventSelector(POOL_MANAGER_EVENTS_ABI[1]),
  Swap: toEventSelector(POOL_MANAGER_EVENTS_ABI[2]),
};

const KNOWN_TOPICS = new Set<string>(Object.values(POOL_MANAGER_TOPICS));

export interface ReceiptLog {
  logIndex: number;
  address: string;
  topics: string[];
  data: string;
}

export type PoolManagerLog =
  | { name: "Initialize"; args: { id: Hex; currency0: Hex; currency1: Hex; fee: number; tickSpacing: number; hooks: Hex; sqrtPriceX96: bigint; tick: number } }
  | { name: "ModifyLiquidity"; args: { id: Hex; sender: Hex; tickLower: number; tickUpper: number; liquidityDelta: bigint; salt: Hex } }
  | { name: "Swap"; args: { id: Hex; sender: Hex; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; liquidity: bigint; tick: number; fee: number } };

/**
 * Decodes a PoolManager log into one of the three handled events, or `undefined`
 * for any other PoolManager event (Donate, ERC-6909 Transfer, ProtocolFee…),
 * which the accounting never read.
 */
export const decodePoolManagerLog = (log: ReceiptLog): PoolManagerLog | undefined => {
  const topic0 = log.topics[0]?.toLowerCase();
  if (!topic0 || !KNOWN_TOPICS.has(topic0)) return undefined;
  const decoded = decodeEventLog({
    abi: POOL_MANAGER_EVENTS_ABI,
    data: log.data as Hex,
    topics: log.topics as [Hex, ...Hex[]],
  });
  return { name: decoded.eventName, args: decoded.args } as PoolManagerLog;
};
