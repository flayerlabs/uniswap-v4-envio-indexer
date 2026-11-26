/*
 * The subscribed NFTX events, as an ABI. config.yaml is the source of
 * truth for what is ingested; this mirror exists so the receipt effect can keep
 * the trigger logs (by topic, address-agnostic) alongside the PoolManager logs,
 * and so tests can turn a stored receipt back into the events that would have
 * fired for it.
 */
import { toEventSelector } from "viem";

const NFTX_EVENTS = [
  { contract: "NFTXLocker", abi: {
    type: "event",
    name: "CollectionInitialized",
    inputs: [
      { name: "_collection", type: "address", indexed: true },
      { name: "_poolKey", type: "bytes", indexed: false },
      { name: "_tokenIds", type: "uint256[]", indexed: false },
      { name: "_sqrtPriceX96", type: "uint256", indexed: false },
      { name: "_sender", type: "address", indexed: false },
    ],
  } },
  { contract: "NFTXV4Hook", abi: {
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
  } },
  { contract: "NFTXFlexHook", abi: {
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
  } },
  { contract: "NFTXFlexHook", abi: {
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
  } },
  { contract: "NFTXHook", abi: {
    type: "event",
    name: "PoolInitialized",
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
  } },
  { contract: "NFTXHook", abi: {
    type: "event",
    name: "PoolStateUpdated",
    inputs: [
      { name: "_poolId", type: "bytes32", indexed: true },
      { name: "_sqrtPriceX96", type: "uint160", indexed: false },
      { name: "_tick", type: "int24", indexed: false },
      { name: "_protocolFee", type: "uint24", indexed: false },
      { name: "_swapFee", type: "uint24", indexed: false },
      { name: "_liquidity", type: "uint128", indexed: false },
    ],
  } },
] as const;

export const NFTX_EVENTS_ABI = NFTX_EVENTS.map(({ abi }) => abi);

export type NftxEventName = (typeof NFTX_EVENTS_ABI)[number]["name"];

/**
 * topic0 -> config.yaml contract. The legacy and unified PoolStateUpdated
 * events share a name but have different signatures (address vs bytes32).
 */
export const NFTX_EVENT_CONTRACT_BY_TOPIC: ReadonlyMap<string, (typeof NFTX_EVENTS)[number]["contract"]> = new Map(
  NFTX_EVENTS.map(({ abi, contract }) => [toEventSelector(abi).toLowerCase(), contract]),
);

/** topic0 -> event name, for every subscribed event. */
export const NFTX_EVENT_BY_TOPIC: ReadonlyMap<string, NftxEventName> = new Map(
  NFTX_EVENTS_ABI.map((event) => [toEventSelector(event).toLowerCase(), event.name]),
);
