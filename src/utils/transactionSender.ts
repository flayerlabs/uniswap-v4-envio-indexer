import { createEffect, S } from "envio";
import { getAddress, type Hash } from "viem";
import { getRpcClient } from "./tokenMetadata";

/** PoolManager logs do not require transaction bodies until we know the pool
 * belongs to NFTX. In particular, fetching `from` for every foreign Arc swap
 * exhausts the RPC before any handler can reject it. Cache once per chain/hash. */
export const getTransactionSender = createEffect(
  {
    name: "getTransactionSender",
    input: S.schema({ chainId: S.number, hash: S.string }),
    output: S.address,
    rateLimit: { calls: 10, per: "second" },
    cache: true,
  },
  async ({ input }) => {
    const transaction = await getRpcClient(input.chainId).getTransaction({
      hash: input.hash as Hash,
    });
    return getAddress(transaction.from);
  },
);
