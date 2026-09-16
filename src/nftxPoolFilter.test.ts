import { describe, expect, it } from "vitest";
import { NFTX_POOL_IDS } from "./utils/nftxPoolIds";
import { nftxPoolIds } from "./utils/nftxPools";
import { nftxPoolId, sortCurrencies } from "./utils/nftxPoolKey";

/**
 * The Swap / ModifyLiquidity handlers index only the pool ids in the generated
 * allowlist, so a wrongly derived id means a pool's volume silently disappears.
 * These pin the two things that make the derivation easy to get wrong: v4 sorts
 * the pair by address, and the hook is part of the key.
 */
const FLETH = "0x000000000bB1f9944965c64066D10038a84F9af2";
const V4_HOOK = "0xaa49ADaDD33c5E953b645567AFb10CBbba63afC4";
const FLEX_HOOK = "0xC26A5Cb51b1818F62a4C6693a9a1feDB3340efc4";

describe("pool id derivation", () => {
  it("sorts the pair by address ascending, whichever side the token lands on", () => {
    const low = "0x0000000000000000000000000000000000000001";
    const high = "0xffffffffffffffffffffffffffffffffffffffff";
    expect(sortCurrencies(high, low)).toEqual([low, high]);
    expect(sortCurrencies(low, high)).toEqual([low, high]);
    // Ordering is by value, not by string: 0x9... < 0xa... but also 0x09 < 0x1f
    expect(sortCurrencies("0x0a", "0x09")).toEqual(["0x09", "0x0a"]);
  });

  it("derives a real mainnet pool whose quote token sorted into currency0", () => {
    // flETH 0x0000…9af2 < collection token 0x188b…900b
    expect(
      nftxPoolId({
        collectionToken: "0x188b1eda9982384a9e3acc7a729415825618900b",
        pairToken: FLETH,
        hooks: V4_HOOK,
      }),
    ).toBe("0x0e660964910a5c4af75309dba8f547a5a4303ac416a3ea54c1a3388cc5f32c91");
  });

  it("gives the same id regardless of which order the pair is passed in", () => {
    const a = nftxPoolId({
      collectionToken: "0x188b1eda9982384a9e3acc7a729415825618900b",
      pairToken: FLETH,
      hooks: V4_HOOK,
    });
    const b = nftxPoolId({
      collectionToken: FLETH,
      pairToken: "0x188b1eda9982384a9e3acc7a729415825618900b",
      hooks: V4_HOOK,
    });
    expect(a).toBe(b);
  });

  it("treats the hook as part of the key", () => {
    const parts = {
      collectionToken: "0x188b1eda9982384a9e3acc7a729415825618900b",
      pairToken: FLETH,
    };
    expect(nftxPoolId({ ...parts, hooks: V4_HOOK })).not.toBe(
      nftxPoolId({ ...parts, hooks: FLEX_HOOK }),
    );
  });

  it("is case-insensitive about addresses", () => {
    const lower = nftxPoolId({
      collectionToken: "0x188b1eda9982384a9e3acc7a729415825618900b",
      pairToken: FLETH.toLowerCase(),
      hooks: V4_HOOK.toLowerCase(),
    });
    const mixed = nftxPoolId({
      collectionToken: "0x188B1EDA9982384A9E3ACC7A729415825618900B",
      pairToken: FLETH,
      hooks: V4_HOOK,
    });
    expect(lower).toBe(mixed);
  });
});

describe("the generated allowlist", () => {
  it("holds lowercase 32-byte ids with no duplicates", () => {
    for (const [chainId, ids] of Object.entries(NFTX_POOL_IDS)) {
      expect(new Set(ids).size, `chain ${chainId} has duplicates`).toBe(ids.length);
      for (const id of ids) {
        expect(id, `chain ${chainId}`).toMatch(/^0x[0-9a-f]{64}$/);
      }
    }
  });

  it("merges ENVIO_NFTX_EXTRA_POOL_IDS so a fresh launch can be indexed without a regen", () => {
    const extra = `0x${"ab".repeat(32)}`;
    process.env.ENVIO_NFTX_EXTRA_POOL_IDS = `1:${extra};5042:${extra}`;
    try {
      expect(nftxPoolIds(1)).toContain(extra);
      expect(nftxPoolIds(1).length).toBe(NFTX_POOL_IDS[1]!.length + 1);
      // A chain with nothing generated still picks the override up.
      expect(nftxPoolIds(5042)).toEqual([extra]);
      // ...and an untouched chain is unaffected.
      expect(nftxPoolIds(4663)).toEqual(NFTX_POOL_IDS[4663]);
    } finally {
      delete process.env.ENVIO_NFTX_EXTRA_POOL_IDS;
    }
  });

  it("rejects a malformed override rather than silently filtering everything out", () => {
    process.env.ENVIO_NFTX_EXTRA_POOL_IDS = "1:0xnot-an-id";
    try {
      expect(() => nftxPoolIds(1)).toThrow(/not a 32-byte pool id/);
    } finally {
      delete process.env.ENVIO_NFTX_EXTRA_POOL_IDS;
    }
  });

  it("covers the chains that have launched and nothing else", () => {
    expect(nftxPoolIds(1).length).toBeGreaterThan(0);
    expect(nftxPoolIds(11155111).length).toBeGreaterThan(0);
    // A chain with no launches must return empty, which the handlers turn into
    // "skip this event entirely" rather than "match everything".
    expect(nftxPoolIds(5042)).toEqual([]);
    expect(nftxPoolIds(999999)).toEqual([]);
  });
});
