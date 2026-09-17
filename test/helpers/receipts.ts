/*
 * Test support for the receipt replay.
 *
 * Fixtures under test/fixtures/receipts are real mainnet receipts trimmed to
 * the PoolManager and NFTX logs (the shape the effect stores). A fixture can be
 * turned back into the subscribed events that fired for it, so a simulated run
 * exercises exactly the trigger→receipt→replay path the live indexer takes,
 * with the node replaced by the stored receipt.
 */
import { readFileSync } from "node:fs";
import { BigDecimal } from "envio";
import {
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  type Hex,
} from "viem";
import { NFTX_EVENT_BY_TOPIC, NFTX_EVENT_CONTRACT, NFTX_EVENTS_ABI } from "../../src/utils/nftxEvents";
import { POOL_MANAGER_EVENTS_ABI } from "../../src/utils/poolManagerEvents";
import { setReceiptSource, type RawReceipt, type ReceiptRequest } from "../../src/utils/transactionReceipt";

export interface ReceiptFixture extends RawReceipt {
  chainId: number;
  blockNumber: number;
  blockTimestamp: number;
  logCount?: number;
  allLogCount: number;
  logs: { logIndex: number; address: string; topics: string[]; data: string }[];
}

export const POOL_MANAGER = "0x000000000004444c5dc75cb358380d2e3de08a90";
export const V4_HOOK = "0xaa49adadd33c5e953b645567afb10cbbba63afc4";
export const FLEX_HOOK = "0xc26a5cb51b1818f62a4c6693a9a1fedb3340efc4";
export const LOCKER = "0xb4c5b5235b98114e9dc227b54e088c11680b2385";

/** Real mainnet transactions, by what they demonstrate. */
export const TX = {
  /** Locker.initializeCollection: Initialize, seed ModifyLiquidity, two PoolStateUpdated, CollectionInitialized. flETH/collection, pool 0x87b6…. */
  canonicalCreation: "0x8acd2da088f3e9ec12378943fd086d246eb1fc4d76180047ba3d019400c403f0",
  /** A swap on a foreign pool then one on canonical 0x87b6…; single PoolStateUpdated. */
  canonicalSwap: "0xc0cd451002faf0997de8e9c30c85071fcf3c17063a47a3da3185e4edfa1af8c4",
  /** Canonical flETH/MILADY pool 0x365b… creation (the pool the multi-pool swap below hits). */
  miladyCanonicalCreation: "0x021c02c6b80182f7f0d48bb70e3cf8e355523e5d165ed24afb32a99ab5c1bd51",
  /** Position 406489: flex MILADY/WETH pool 0x7169… created and seeded (FlexPoolInitialized, Initialize, ModifyLiquidity, FlexPoolStateUpdated). */
  flexCreation: "0xf5839651438c871a86af38bae176be9be5ac682bdff74916f8a0eea13996a4f7",
  /** One transaction swapping a foreign pool, canonical 0x365b… and flex 0x7169…: PoolStateUpdated and FlexPoolStateUpdated both fire. */
  multiPoolSwap: "0x9c7426ac868698c631ce6bef36e74900dd0b66b0ffb427ba4d4848ce3dee610b",
  /** Flex CULT/MILADY pool 0x2fab… created and seeded. */
  cultFlexCreation: "0xec24e701872801675ed429a17cdc478637a4e551b6d231a4329a1b0468bcd6c6",
  /** Liquidity removed from 0x2fab…: a negative-delta ModifyLiquidity, FlexPoolStateUpdated. */
  cultFlexRemoval: "0xf5a1d07674a5ad25bd9be096564932d8075c4fc01bf6fb470081c15635570fae",
} as const;

export const loadFixture = (hash: string, chainId = 1): ReceiptFixture =>
  JSON.parse(readFileSync(new URL(`../fixtures/receipts/${chainId}_${hash}.json`, import.meta.url), "utf8"));

/**
 * The subscribed events a receipt would have produced, as simulate items, in
 * log order. The handler reads none of the params, but the harness decodes
 * them, so they are the real ones (with the flex PoolKey in the positional
 * shape HyperIndex hands tuples over in).
 */
export const triggersFrom = (fixture: ReceiptFixture) =>
  fixture.logs
    .filter((log) => NFTX_EVENT_BY_TOPIC.has(log.topics[0]!.toLowerCase()))
    .map((log) => {
      const event = NFTX_EVENT_BY_TOPIC.get(log.topics[0]!.toLowerCase())!;
      const decoded = decodeEventLog({ abi: NFTX_EVENTS_ABI, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
      const params: Record<string, unknown> = { ...(decoded.args as Record<string, unknown>) };
      if (decoded.eventName === "FlexPoolInitialized") {
        const key = decoded.args._key;
        params._key = { 0: key.currency0, 1: key.currency1, 2: BigInt(key.fee), 3: BigInt(key.tickSpacing), 4: key.hooks };
      }
      return {
        contract: NFTX_EVENT_CONTRACT[event],
        event,
        srcAddress: getAddress(log.address),
        logIndex: log.logIndex,
        block: { number: fixture.blockNumber, timestamp: fixture.blockTimestamp, hash: fixture.blockHash },
        transaction: { hash: fixture.transactionHash },
        params,
      };
    });

/** Every PoolManager log in a fixture, decoded. */
export const poolManagerLogsOf = (fixture: ReceiptFixture) =>
  fixture.logs
    .filter((log) => log.address.toLowerCase() === POOL_MANAGER)
    .map((log) => ({
      logIndex: log.logIndex,
      ...decodeEventLog({ abi: POOL_MANAGER_EVENTS_ABI, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] }),
    }));

/**
 * A receipt source backed by a set of fixtures, counting every request. Any
 * transaction it was not given resolves to `null` (as a node without it would).
 */
export const fixtureSource = (fixtures: ReceiptFixture[]) => {
  const byHash = new Map(fixtures.map((fixture) => [fixture.transactionHash.toLowerCase(), fixture]));
  const requests: ReceiptRequest[] = [];
  const source = async (request: ReceiptRequest): Promise<RawReceipt | null> => {
    requests.push(request);
    return byHash.get(request.hash.toLowerCase()) ?? null;
  };
  return { source, requests, install: () => setReceiptSource(source) };
};

/** Presets a Token so pool creation never has to read metadata over RPC. */
export const presetToken = (
  indexer: { Token: { set: (token: any) => void } },
  chainId: number,
  address: string,
  symbol: string,
  decimals = 18n,
) => {
  indexer.Token.set({
    id: `${chainId}_${address.toLowerCase()}`,
    chainId: BigInt(chainId),
    symbol,
    name: symbol,
    decimals,
    totalSupply: 0n,
    volume: new BigDecimal("0"),
    volumeUSD: new BigDecimal("0"),
    untrackedVolumeUSD: new BigDecimal("0"),
    feesUSD: new BigDecimal("0"),
    txCount: 0n,
    poolCount: 0n,
    totalValueLocked: new BigDecimal("0"),
    totalValueLockedUSD: new BigDecimal("0"),
    totalValueLockedUSDUntracked: new BigDecimal("0"),
    derivedETH: new BigDecimal("0"),
    whitelistPools: [],
  });
};

/** The tokens the mainnet fixtures are denominated in. All 18 decimals. */
export const FIXTURE_TOKENS: Record<string, string> = {
  "0x000000000bb1f9944965c64066d10038a84f9af2": "flETH",
  "0x370e49749b9ff90004f3186aa7135487acc2a8fc": "COLLECTION",
  "0x8b3bc6942d6823a8022605648b671a2feb954800": "MILADY",
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "WETH",
  "0x0000000000c5dc95539589fbd24be07c6c14eca4": "CULT",
};

export const presetFixtureTokens = (indexer: { Token: { set: (token: any) => void } }, chainId = 1) => {
  for (const [address, symbol] of Object.entries(FIXTURE_TOKENS)) presetToken(indexer, chainId, address, symbol);
};

// ---- synthetic logs, for receipts no real transaction produced ----

type PoolManagerEventName = (typeof POOL_MANAGER_EVENTS_ABI)[number]["name"];
type NftxEventName = (typeof NFTX_EVENTS_ABI)[number]["name"];

const encodeLog = (abi: readonly any[], eventName: string, args: Record<string, unknown>, address: string, logIndex: number) => {
  const event = abi.find((item) => item.name === eventName)!;
  const topics = encodeEventTopics({ abi, eventName, args } as any) as string[];
  const nonIndexed = event.inputs.filter((input: { indexed?: boolean }) => !input.indexed);
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((input: { name: string }) => args[input.name]));
  return { logIndex, address, topics, data };
};

export const poolManagerLog = (eventName: PoolManagerEventName, args: Record<string, unknown>, logIndex: number) =>
  encodeLog(POOL_MANAGER_EVENTS_ABI, eventName, args, POOL_MANAGER, logIndex);

export const nftxLog = (eventName: NftxEventName, args: Record<string, unknown>, address: string, logIndex: number) =>
  encodeLog(NFTX_EVENTS_ABI, eventName, args, address, logIndex);

/** Wraps synthetic logs in a receipt at a made-up block. */
export const syntheticReceipt = (
  hash: string,
  logs: ReceiptFixture["logs"],
  overrides: Partial<ReceiptFixture> = {},
): ReceiptFixture => ({
  chainId: 1,
  transactionHash: hash,
  blockNumber: 25_700_000,
  blockHash: `0x${"11".repeat(32)}`,
  blockTimestamp: 1_786_000_000,
  transactionIndex: 0,
  from: "0x00000000000000000000000000000000000000aa",
  status: "success",
  allLogCount: logs.length,
  logs: [...logs].sort((a, b) => a.logIndex - b.logIndex),
  ...overrides,
});
