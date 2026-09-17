/** Deployed NFTX hooks, not a list of pools. Every pool using one is discovered
 * from Initialize before its first deposit, regardless of currencies or price.
 * Keep these deployments aligned with the NFTX indexer and API contract books. */
const V4_HOOK = "0xaa49adadd33c5e953b645567afb10cbbba63afc4";
const FLEX_HOOK = "0xc26a5cb51b1818f62a4c6693a9a1fedb3340efc4";

export const NFTX_HOOKS: Readonly<Record<number, readonly string[]>> = {
  1: [V4_HOOK, FLEX_HOOK],
  11155111: [V4_HOOK],
  4663: [V4_HOOK],
  57073: [V4_HOOK],
  5042: [V4_HOOK],
  42161: [V4_HOOK],
};

export const isNftxHook = (chainId: number, hooks: string): boolean =>
  NFTX_HOOKS[chainId]?.includes(hooks.toLowerCase()) ?? false;
