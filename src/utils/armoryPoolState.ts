/*
 * Reads an Armory pool's price at a past block. Only needed for a pool that was
 * initialised before NFTX registered its collection: anyone can create and
 * initialise the pool for a predictable collection-token address ahead of time,
 * and NFTXArmory then reprices or reuses it at launch. Its Initialize log predates
 * the dynamic registration, so the first log this indexer sees is the launch's
 * Swap or Mint, and the pool row is seeded from slot0 at the block before it.
 */
import { createEffect, S, type EvmChainId } from "envio";
import { createPublicClient, http, type PublicClient } from "viem";
import { METADATA_RPC_RETRY, getRpcUrl } from "./tokenMetadata";

const SLOT0_ABI = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;

/** A plain client: one historical eth_call, no multicall folding. */
const clients: Record<number, PublicClient> = {};
const clientFor = (chainId: number): PublicClient =>
  (clients[chainId] ??= createPublicClient({ transport: http(getRpcUrl(chainId), { batch: false, ...METADATA_RPC_RETRY }) }));

export const getArmoryPoolState = createEffect(
  {
    name: "getArmoryPoolState",
    input: S.tuple((t) => ({
      chainId: t.item(0, S.number as S.Schema<EvmChainId>),
      pool: t.item(1, S.address),
      blockNumber: t.item(2, S.number),
    })),
    output: S.schema({ sqrtPriceX96: S.bigint, tick: S.bigint }),
    // Once per pre-initialised pool, ever.
    rateLimit: { calls: 2, per: "second" },
    cache: true,
  },
  async ({ input: { chainId, pool, blockNumber } }) => {
    const [sqrtPriceX96, tick] = await clientFor(chainId).readContract({
      address: pool,
      abi: SLOT0_ABI,
      functionName: "slot0",
      blockNumber: BigInt(blockNumber),
    });
    return { sqrtPriceX96, tick: BigInt(tick) };
  },
);
