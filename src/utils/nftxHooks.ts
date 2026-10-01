/** Deployed NFTX hooks, not a list of pools. Every pool using one is discovered
 * from Initialize before its first deposit, regardless of currencies or price.
 * Keep these deployments aligned with the NFTX indexer and API contract books. */
const V4_HOOK = "0xaa49adadd33c5e953b645567afb10cbbba63afc4";
const FLEX_HOOK = "0xc26a5cb51b1818f62a4c6693a9a1fedb3340efc4";
/** ApeChain has no hook: NFTXArmory plays its role for Armory V3 pools (src/utils/armory.ts). */
const ARMORY_MARKET = "0x198dce74c3f765299a5371f89e45377172042475";

export const NFTX_HOOKS: Readonly<Record<number, readonly string[]>> = {
  1: [V4_HOOK, FLEX_HOOK],
  8453: [V4_HOOK],
  11155111: [V4_HOOK],
  4663: [V4_HOOK],
  57073: [V4_HOOK],
  5042: [V4_HOOK],
  42161: [V4_HOOK],
  33139: [ARMORY_MARKET],
};

export const isNftxHook = (chainId: number, hooks: string): boolean =>
  NFTX_HOOKS[chainId]?.includes(hooks.toLowerCase()) ?? false;
