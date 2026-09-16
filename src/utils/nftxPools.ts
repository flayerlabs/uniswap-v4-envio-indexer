/*
 * The pool allowlist the Swap and ModifyLiquidity handlers filter on.
 *
 * The PoolManager is a singleton, so those events carry every v4 swap and every
 * LP move on the chain. Measured against live data, NFTX pools are 0.007% of
 * mainnet swaps and 0.003% of Robinhood's. `id` is an indexed topic, so this
 * list is pushed down into the HyperSync/RPC query: everything else is never
 * delivered to the indexer and never counted against the event-processing quota.
 *
 * The generated list is the committed source. ENVIO_NFTX_EXTRA_POOL_IDS adds to
 * it without a code change, which is the lever to reach for when a collection
 * launches and you want its pool indexed before the next regeneration:
 *
 *   ENVIO_NFTX_EXTRA_POOL_IDS="1:0xabc…,0xdef…;11155111:0x123…"
 *
 * Nothing is lost by being late. A redeploy re-indexes from the chain's
 * start_block through this filter, so a pool added later is backfilled from its
 * own Initialize — being absent delays its volume, it does not drop it.
 */
import { NFTX_POOL_IDS } from "./nftxPoolIds";

const ENV_VAR = "ENVIO_NFTX_EXTRA_POOL_IDS";

/** Parses `chainId:id,id;chainId:id`. A malformed entry throws rather than silently filtering everything out. */
const parseExtra = (raw: string): Record<number, string[]> => {
  const out: Record<number, string[]> = {};
  for (const group of raw.split(";")) {
    const trimmed = group.trim();
    if (!trimmed) continue;
    const [chainPart, idPart = ""] = trimmed.split(":");
    const chainId = Number(chainPart);
    if (!Number.isInteger(chainId)) {
      throw new Error(`${ENV_VAR}: "${chainPart}" is not a chain id`);
    }
    for (const id of idPart.split(",")) {
      const value = id.trim().toLowerCase();
      if (!value) continue;
      if (!/^0x[0-9a-f]{64}$/.test(value)) {
        throw new Error(`${ENV_VAR}: "${value}" is not a 32-byte pool id`);
      }
      (out[chainId] ??= []).push(value);
    }
  }
  return out;
};

let cache: { raw: string | undefined; parsed: Record<number, string[]> } | undefined;

const extraPoolIds = (chainId: number): readonly string[] => {
  const raw = process.env[ENV_VAR];
  if (!raw) return [];
  if (!cache || cache.raw !== raw) cache = { raw, parsed: parseExtra(raw) };
  return cache.parsed[chainId] ?? [];
};

/**
 * The pool ids to index on `chainId`. Empty means "this chain has no NFTX
 * pools" — the handlers turn that into skipping the event outright, which is
 * what we want on a chain that is deployed but has not launched anything.
 */
export const nftxPoolIds = (chainId: number): readonly string[] => {
  const generated = NFTX_POOL_IDS[chainId] ?? [];
  const extra = extraPoolIds(chainId);
  return extra.length ? [...new Set([...generated, ...extra])] : generated;
};
