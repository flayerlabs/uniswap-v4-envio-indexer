/*
 * What every accounting step knows about the transaction it is replaying.
 * Everything comes from the receipt and the triggering event's block — none of
 * it from the PoolManager log itself, which carries no transaction context.
 */
import type { EvmOnEventContext } from "envio";
import type { getChainConfig } from "../utils/chains";

export type IndexedChainId = Parameters<typeof getChainConfig>[0];

export interface ReplayTransaction {
  chainId: IndexedChainId;
  hash: string;
  /** Checksummed receipt `from`. */
  origin: string;
  block: { number: number; timestamp: number };
}

export type HandlerContext = EvmOnEventContext;
