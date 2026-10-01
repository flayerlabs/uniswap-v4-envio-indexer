import { describe, expect, it } from "vitest";
import { ARMORY, armoryPoolId, computeArmoryPool, computeV3PoolAddress, sortTokens } from "./utils/armory";
import { NFTX_HOOKS } from "./utils/nftxHooks";
import { getChainConfig } from "./utils/chains";

const APECHAIN = 33139;
const config = ARMORY[APECHAIN]!;

describe("Armory pool addressing", () => {
  it("derives a live Armory pool address from the factory, init code hash and key", () => {
    // PoolCreated on the Armory V3 factory, ApeChain block ~44.8M: WAPE / 0x7518…
    // on the 2.5% tier, deployed at 0x99ec6a39….
    const pool = computeV3PoolAddress(
      config.factory,
      config.poolInitCodeHash,
      "0x48b62137edfa95a428d35c09e44256a739f6b557",
      "0x75186fa1427b69a1e64d922e9f2c64a91ab1b4a4",
      25_000n,
    );
    expect(pool).toBe("0x99ec6a394d277c332dc22a9e48b16bb771bc7b8c");
  });

  it("sorts a collection token against WAPE on either side", () => {
    expect(sortTokens(APECHAIN, "0x0000000000000000000000000000000000000001")).toEqual([
      "0x0000000000000000000000000000000000000001",
      config.nativeToken,
    ]);
    expect(sortTokens(APECHAIN, "0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF")).toEqual([
      config.nativeToken,
      "0xffffffffffffffffffffffffffffffffffffffff",
    ]);
  });

  it("keys the NFTX pool on the configured tier, whichever token sorts first", () => {
    const token = "0x0000000000000000000000000000000000000001";
    expect(computeArmoryPool(APECHAIN, token)).toBe(
      computeV3PoolAddress(config.factory, config.poolInitCodeHash, token, config.nativeToken, config.fee),
    );
  });

  it("uses the pool address, left-padded, as the pool id NFTXArmory reports", () => {
    expect(armoryPoolId("0x99EC6a394D277C332dC22A9E48b16bB771bc7b8C")).toBe(
      "0x00000000000000000000000099ec6a394d277c332dc22a9e48b16bb771bc7b8c",
    );
  });

  it("admits NFTXArmory as ApeChain's only NFTX hook and points the chain at WAPE", () => {
    expect(NFTX_HOOKS[APECHAIN]).toEqual([config.market]);
    expect(getChainConfig(APECHAIN).wrappedNativeAddress).toBe(config.nativeToken);
    expect(getChainConfig(APECHAIN).poolManagerAddress).toBe(config.factory);
  });
});
