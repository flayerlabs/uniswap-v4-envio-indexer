/*
 * The four subscribed NFTX events, as an ABI. config.yaml is the source of
 * truth for what is ingested; this mirror exists so the receipt effect can keep
 * the trigger logs (by topic, address-agnostic) alongside the PoolManager logs,
 * and so tests can turn a stored receipt back into the events that would have
 * fired for it.
 */
import { toEventSelector } from "viem";

export const NFTX_EVENTS_ABI = [
  {
    type: "event",
    name: "CollectionInitialized",
    inputs: [
      { name: "_collection", type: "address", indexed: true },
      { name: "_poolKey", type: "bytes", indexed: false },
      { name: "_tokenIds", type: "uint256[]", indexed: false },
      { name: "_sqrtPriceX96", type: "uint256", indexed: false },
      { name: "_sender", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PoolStateUpdated",
    inputs: [
      { name: "_collection", type: "address", indexed: true },
      { name: "_sqrtPriceX96", type: "uint160", indexed: false },
      { name: "_tick", type: "int24", indexed: false },
      { name: "_protocolFee", type: "uint24", indexed: false },
      { name: "_swapFee", type: "uint24", indexed: false },
      { name: "_liquidity", type: "uint128", indexed: false },
    ],
  },
  {
    type: "event",
    name: "FlexPoolInitialized",
    inputs: [
      { name: "_poolId", type: "bytes32", indexed: true },
      { name: "_collectionToken", type: "address", indexed: true },
      { name: "_pairToken", type: "address", indexed: true },
      {
        name: "_key",
        type: "tuple",
        indexed: false,
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "_sqrtPriceX96", type: "uint160", indexed: false },
    ],
  },
  {
    type: "event",
    name: "FlexPoolStateUpdated",
    inputs: [
      { name: "_poolId", type: "bytes32", indexed: true },
      { name: "_sqrtPriceX96", type: "uint160", indexed: false },
      { name: "_tick", type: "int24", indexed: false },
      { name: "_protocolFee", type: "uint24", indexed: false },
      { name: "_swapFee", type: "uint24", indexed: false },
      { name: "_liquidity", type: "uint128", indexed: false },
    ],
  },
] as const;

export type NftxEventName = (typeof NFTX_EVENTS_ABI)[number]["name"];

/** The contract each subscribed event is declared under in config.yaml. */
export const NFTX_EVENT_CONTRACT: Readonly<Record<NftxEventName, "NFTXLocker" | "NFTXV4Hook" | "NFTXFlexHook">> = {
  CollectionInitialized: "NFTXLocker",
  PoolStateUpdated: "NFTXV4Hook",
  FlexPoolInitialized: "NFTXFlexHook",
  FlexPoolStateUpdated: "NFTXFlexHook",
};

/** topic0 -> event name, for every subscribed event. */
export const NFTX_EVENT_BY_TOPIC: ReadonlyMap<string, NftxEventName> = new Map(
  NFTX_EVENTS_ABI.map((event) => [toEventSelector(event).toLowerCase(), event.name]),
);
