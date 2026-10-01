/*
 * Armory: the ApeChain DEX NFTX trades through, a byte-level Uniswap V3 fork.
 * ApeChain has no V4 PoolManager, so its NFTX pools are not reached through the
 * receipt replay at all. Each collection trades in one dedicated V3 pool on a
 * fixed fee tier; the pool is registered as a dynamic contract when NFTXArmory
 * registers the collection, and its own Initialize/Swap/Mint/Burn logs are
 * indexed directly (src/handlers/armory.ts). That covers trades routed through
 * NFTX and trades made directly on Armory alike.
 *
 * Keep these values aligned with Flayer/Contracts NFTXArmory and its deployment.
 */
import { encodeAbiParameters, getContractAddress, keccak256, pad, type Hex } from "viem";

export interface ArmoryConfig {
  /** The NFTXArmory market, which plays the hook's role in Pool.hooks and HookStats. */
  market: string;
  /** Armory V3 factory; also stands in for the PoolManager entity on this chain. */
  factory: string;
  /** Uniswap V3's canonical pool init code hash, which Armory's pool shares. */
  poolInitCodeHash: Hex;
  /** The single fee tier every NFTX collection pool uses, in hundredths of a bip. */
  fee: bigint;
  /** Tick spacing of that tier. */
  tickSpacing: bigint;
  /** WAPE, paired with every collection token. */
  nativeToken: string;
}

export const ARMORY: Readonly<Record<number, ArmoryConfig>> = {
  33139: {
    market: "0x198dce74c3f765299a5371f89e45377172042475",
    factory: "0xab52edb039b07b0d64345ea66696871bf33b434f",
    poolInitCodeHash: "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54",
    fee: 10_000n,
    tickSpacing: 200n,
    nativeToken: "0x48b62137edfa95a428d35c09e44256a739f6b557",
  },
};

export const getArmoryConfig = (chainId: number): ArmoryConfig => {
  const config = ARMORY[chainId];
  if (!config) throw new Error(`No Armory configuration for chainId ${chainId}`);
  return config;
};

/** Sorts a collection token against WAPE into V3 pool order. */
export const sortTokens = (chainId: number, collectionToken: string): [string, string] => {
  const native = getArmoryConfig(chainId).nativeToken;
  const token = collectionToken.toLowerCase();
  return token < native ? [token, native] : [native, token];
};

/** The pool address exactly as the V3 periphery's PoolAddress.computeAddress derives it. */
export const computeV3PoolAddress = (
  factory: string,
  poolInitCodeHash: Hex,
  token0: string,
  token1: string,
  fee: bigint,
): string => {
  const salt = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }],
      [token0 as Hex, token1 as Hex, Number(fee)],
    ),
  );
  return getContractAddress({ opcode: "CREATE2", from: factory as Hex, salt, bytecodeHash: poolInitCodeHash }).toLowerCase();
};

/** A collection token's NFTX pool: paired with WAPE on the configured fee tier. */
export const computeArmoryPool = (chainId: number, collectionToken: string): string => {
  const config = getArmoryConfig(chainId);
  const [token0, token1] = sortTokens(chainId, collectionToken);
  return computeV3PoolAddress(config.factory, config.poolInitCodeHash, token0, token1, config.fee);
};

/**
 * The pool's id in this indexer: its address left-padded to 32 bytes, which is
 * also what NFTXArmory.getCollectionPoolId returns, so API reads line up.
 */
export const armoryPoolId = (pool: string): string => pad(pool.toLowerCase() as Hex, { size: 32 }).toLowerCase();
