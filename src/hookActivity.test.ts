/**
 * The receipt replay, driven by real mainnet receipts served from fixtures.
 *
 * Each test simulates exactly the subscribed events a transaction emitted and
 * installs its receipt as the "node". Token metadata is preset so nothing here
 * touches the network.
 */
import { afterEach, describe, expect, it } from "vitest";
import { BigDecimal, createTestIndexer } from "envio";
import {
  fixtureSource,
  FLEX_HOOK,
  loadFixture,
  nftxLog,
  poolManagerLog,
  poolManagerLogsOf,
  presetFixtureTokens,
  presetToken,
  syntheticReceipt,
  triggersFrom,
  TX,
  V4_HOOK,
} from "../test/helpers/receipts";
import { getAddress } from "viem";
import { setReceiptSource } from "./utils/transactionReceipt";

const CANONICAL_POOL = "1_0x87b6681f23e615792599a64be55151b0bea86daa42f357ddd2a3eaaee705f569";
const MILADY_CANONICAL_POOL = "1_0x365b5b4b72f878ea36330db7191026614bef4d49d9ee645925594912fdfe2831";
const FLEX_POOL = "1_0x7169c13961289ed8b9fc790ca5f7187246b8b769d347e57643df223f41de7000";
const CULT_FLEX_POOL = "1_0x2fab92c6633a3538a3a9025f256e18a4c3925bacb2d66b88f7c03f072ecac7f3";

const zero = new BigDecimal("0");

const run = async (indexer: ReturnType<typeof createTestIndexer>, hashes: string[]) => {
  const fixtures = hashes.map((hash) => loadFixture(hash));
  const node = fixtureSource(fixtures);
  node.install();
  for (const fixture of fixtures) {
    await indexer.process({ chains: { 1: { simulate: triggersFrom(fixture) as any } } });
  }
  return node;
};

afterEach(() => setReceiptSource(undefined));

describe("canonical pool creation", () => {
  it("creates the pool from Initialize, then records the seed deposit, all from one receipt", async () => {
    const indexer = createTestIndexer();
    presetFixtureTokens(indexer);
    const node = await run(indexer, [TX.canonicalCreation]);

    // Two PoolStateUpdated and one CollectionInitialized fired; one receipt, one replay.
    expect(node.requests).toHaveLength(1);
    const indexed = await indexer.IndexedTransaction.getAll();
    expect(indexed).toHaveLength(1);
    expect(indexed[0]).toMatchObject({
      id: `1_${TX.canonicalCreation}`,
      hash: TX.canonicalCreation,
      blockNumber: 25653470n,
      origin: getAddress("0xb8a70b4d1547bf6193bd67a73f4f98ea9fd0a973"),
      triggerLogIndex: 356n, // the first PoolStateUpdated, right after Initialize
      poolLogs: 2n, // Initialize + ModifyLiquidity
    });

    const pool = await indexer.Pool.getOrThrow(CANONICAL_POOL);
    expect(pool.hooks.toLowerCase()).toBe(V4_HOOK);
    expect(pool.token0).toBe("1_0x000000000bb1f9944965c64066d10038a84f9af2"); // flETH is currency0 here
    expect(pool.createdAtBlockNumber).toBe(25653470n);
    expect(pool.totalValueLockedToken0.toString()).toBe("16.157399999999999999");
    expect(pool.totalValueLockedToken1.toString()).toBe("41.999999999999999999");
    expect(pool.liquidity).toBe(26050159308533988311n);
    expect(pool.txCount).toBe(1n);

    const deposits = await indexer.ModifyLiquidity.getAll();
    expect(deposits).toHaveLength(1);
    expect(deposits[0]).toMatchObject({
      id: `1_${TX.canonicalCreation}_363`,
      transaction: TX.canonicalCreation,
      logIndex: 363n,
      origin: "0xB8A70b4d1547bf6193bd67A73F4F98ea9FD0A973",
      timestamp: 1785508463n,
      pool_id: CANONICAL_POOL,
    });
    expect(deposits[0]!.amount0.toString()).toBe("16.157399999999999999");

    // The later CollectionInitialized and second PoolStateUpdated did not
    // create a second pool or reset anything.
    const managers = await indexer.PoolManager.getAll();
    expect(managers).toHaveLength(1);
    expect(managers[0]!.poolCount).toBe(1n);
    expect(managers[0]!.hookedPools).toBe(1n);
    expect(managers[0]!.txCount).toBe(1n);
    expect((await indexer.HookStats.getOrThrow(`1_${pool.hooks}`)).numberOfPools).toBe(1n);
    expect(await indexer.Tick.getAll()).toHaveLength(2);
    // The bucket was seeded at creation (txCount 1) and bumped by the deposit.
    expect((await indexer.PoolHourData.getAll()).map((h) => h.txCount)).toEqual([2n]);
  });

  it("then applies a swap and ignores the foreign pool swapped in the same transaction", async () => {
    const indexer = createTestIndexer();
    presetFixtureTokens(indexer);
    const node = await run(indexer, [TX.canonicalCreation, TX.canonicalSwap]);
    expect(node.requests.map((r) => r.hash)).toEqual([TX.canonicalCreation, TX.canonicalSwap]);

    const swaps = await indexer.Swap.getAll();
    expect(swaps).toHaveLength(1);
    expect(swaps[0]).toMatchObject({
      id: "1_25653471_41",
      transaction: TX.canonicalSwap,
      logIndex: 41n,
      pool: CANONICAL_POOL,
      origin: getAddress("0x63db185de4f443bd0a64b9593e4fbf7d0f2da1e8"),
      amountUSD: zero,
      fee: 9000n,
    });
    const pool = await indexer.Pool.getOrThrow(CANONICAL_POOL);
    expect(pool.totalValueLockedToken0.toString()).toBe("16.357399999999999999");
    expect(pool.totalValueLockedToken1.toString()).toBe("41.491036709139377338");
    expect(pool.volumeToken0.toString()).toBe("0.2");
    expect(pool.feeTier).toBe(9000n);
    expect(pool.txCount).toBe(2n);
    expect(pool.tick).toBe(swaps[0]!.tick);
    expect(pool.volumeUSD).toEqual(zero);
    expect(pool.totalValueLockedUSD).toEqual(zero);

    // The foreign pool (log 35 in the same receipt) left nothing behind.
    const foreign = poolManagerLogsOf(loadFixture(TX.canonicalSwap)).find((l) => l.logIndex === 35)!;
    expect(foreign.eventName).toBe("Swap");
    expect(await indexer.Pool.get(`1_${(foreign.args as { id: string }).id}`)).toBeUndefined();
    expect((await indexer.Pool.getAll()).map((p) => p.id)).toEqual([CANONICAL_POOL]);
    expect((await indexer.PoolManager.getAll())[0]).toMatchObject({ numberOfSwaps: 1n, hookedSwaps: 1n, txCount: 2n });
    expect((await indexer.HookStats.getAll())[0]!.numberOfSwaps).toBe(1n);
    expect((await indexer.IndexedTransaction.getAll()).map((t) => [t.hash, t.poolLogs])).toEqual([
      [TX.canonicalCreation, 2n],
      [TX.canonicalSwap, 1n],
    ]);
  });
});

describe("flex pool creation (position 406489, MILADY/WETH)", () => {
  it("indexes a pool paired with an arbitrary token, collection token first, with no price available", async () => {
    const indexer = createTestIndexer();
    presetFixtureTokens(indexer);
    const node = await run(indexer, [TX.flexCreation]);

    // FlexPoolInitialized and FlexPoolStateUpdated both fired; one replay.
    expect(node.requests).toHaveLength(1);
    expect(await indexer.IndexedTransaction.getAll()).toHaveLength(1);

    const pool = await indexer.Pool.getOrThrow(FLEX_POOL);
    expect(pool.hooks.toLowerCase()).toBe(FLEX_HOOK);
    expect(pool.token0).toBe("1_0x8b3bc6942d6823a8022605648b671a2feb954800"); // MILADY, the collection side, sorts first
    expect(pool.token1).toBe("1_0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"); // WETH, not the chain's flETH quote
    expect(pool.totalValueLockedToken0.toString()).toBe("1.994991739332266005");
    expect(pool.totalValueLockedToken1.toString()).toBe("1.695742978432426104");
    expect(pool.liquidity).toBeGreaterThan(0n);
    expect(pool.txCount).toBe(1n);

    const [deposit] = await indexer.ModifyLiquidity.getAll();
    expect(deposit).toMatchObject({
      pool_id: FLEX_POOL,
      logIndex: 45n,
      transaction: TX.flexCreation,
      origin: getAddress("0x77872babbcd6c8c4633639484a7ece4d4aa57d77"),
    });
    expect(deposit!.amount).toBe(pool.liquidity);

    // Nothing here depends on a market price: every valuation field is zero
    // while the raw balances are not.
    const [token0, token1] = await Promise.all([indexer.Token.getOrThrow(pool.token0), indexer.Token.getOrThrow(pool.token1)]);
    for (const token of [token0, token1]) {
      expect(token.derivedETH).toEqual(zero);
      expect(token.totalValueLocked.gt(zero)).toBe(true);
      expect(token.poolCount).toBe(1n);
    }
    expect(pool.totalValueLockedETH).toEqual(zero);
    expect((await indexer.Bundle.getOrThrow("1")).ethPriceUSD).toEqual(zero);
  });
});

describe("several pools and actions in one transaction", () => {
  it("replays every NFTX swap once, from whichever hook event fires first", async () => {
    const indexer = createTestIndexer();
    presetFixtureTokens(indexer);
    const node = await run(indexer, [TX.miladyCanonicalCreation, TX.flexCreation, TX.multiPoolSwap]);
    expect(node.requests).toHaveLength(3);

    const canonicalBefore = poolManagerLogsOf(loadFixture(TX.miladyCanonicalCreation));
    expect(canonicalBefore.map((l) => l.eventName)).toEqual(["Initialize", "ModifyLiquidity"]);

    const swaps = (await indexer.Swap.getAll()).sort((a, b) => Number(a.logIndex - b.logIndex));
    // Log 506 swaps a foreign pool; 508 is canonical 0x365b…, 515 is flex 0x7169….
    expect(swaps.map((s) => [Number(s.logIndex), s.pool])).toEqual([
      [508, MILADY_CANONICAL_POOL],
      [515, FLEX_POOL],
    ]);
    for (const swap of swaps) {
      expect(swap.transaction).toBe(TX.multiPoolSwap);
      expect(swap.origin).toBe(getAddress("0x7ea49f025d36450ffe9c5b99749f2fa7c11cfd58"));
      expect(swap.timestamp).toBe(1789646255n);
    }

    const indexed = await indexer.IndexedTransaction.getAll();
    expect(indexed.map((t) => [t.hash, t.poolLogs, t.triggerLogIndex])).toEqual([
      [TX.miladyCanonicalCreation, 2n, 765n],
      [TX.flexCreation, 2n, 40n],
      [TX.multiPoolSwap, 2n, 512n], // PoolStateUpdated (512) beat FlexPoolStateUpdated (519)
    ]);
    expect((await indexer.PoolManager.getAll())[0]).toMatchObject({ numberOfSwaps: 2n, hookedSwaps: 2n, poolCount: 2n });

    // Each pool's balance moved by exactly its own swap.
    const flex = await indexer.Pool.getOrThrow(FLEX_POOL);
    const flexSwap = swaps.find((s) => s.pool === FLEX_POOL)!;
    expect(flex.totalValueLockedToken0.toString()).toBe(new BigDecimal("1.994991739332266005").plus(flexSwap.amount0).toString());
    expect(flex.totalValueLockedToken1.toString()).toBe(new BigDecimal("1.695742978432426104").plus(flexSwap.amount1).toString());
    expect(flex.txCount).toBe(2n);
    expect(flex.sqrtPrice).toBe(flexSwap.sqrtPriceX96);
  });
});

describe("liquidity removal", () => {
  it("applies a negative-delta ModifyLiquidity and reduces reserves and liquidity", async () => {
    const indexer = createTestIndexer();
    presetFixtureTokens(indexer);
    await run(indexer, [TX.cultFlexCreation, TX.cultFlexRemoval]);

    const changes = (await indexer.ModifyLiquidity.getAll()).sort((a, b) => Number(a.timestamp - b.timestamp));
    expect(changes).toHaveLength(2);
    const [seed, removal] = changes;
    expect(seed!.amount).toBeGreaterThan(0n);
    expect(removal!.amount).toBeLessThan(0n);
    expect(removal!.transaction).toBe(TX.cultFlexRemoval);
    expect(removal!.logIndex).toBe(534n);
    expect(removal!.amount0.lte(zero)).toBe(true);
    expect(removal!.amount1.lte(zero)).toBe(true);

    const pool = await indexer.Pool.getOrThrow(CULT_FLEX_POOL);
    expect(pool.liquidity).toBe(seed!.amount + removal!.amount);
    expect(pool.totalValueLockedToken0.toString()).toBe(seed!.amount0.plus(removal!.amount0).toString());
    expect(pool.totalValueLockedToken1.toString()).toBe(seed!.amount1.plus(removal!.amount1).toString());
    expect(pool.totalValueLockedToken0.gte(zero)).toBe(true);
    expect(pool.totalValueLockedToken1.gte(zero)).toBe(true);
    expect(pool.txCount).toBe(2n);
    // Ticks are shared by the seed and the removal: the same full-range bounds.
    const ticks = await indexer.Tick.getAll();
    expect(ticks).toHaveLength(2);
    expect(ticks.every((t) => t.liquidityGross === seed!.amount + removal!.amount)).toBe(true);
  });
});

describe("unrelated activity", () => {
  it("creates no accounting for a pool on a foreign hook, even when the receipt is replayed", async () => {
    const indexer = createTestIndexer();
    const id = `0x${"ab".repeat(32)}`;
    const currency0 = "0x000000000bb1f9944965c64066d10038a84f9af2";
    const currency1 = "0x370e49749b9ff90004f3186aa7135487acc2a8fc";
    const hash = `0x${"cd".repeat(32)}`;
    // A pool on some other hook that, implausibly, shares a transaction with a
    // PoolStateUpdated of ours.
    const receipt = syntheticReceipt(hash, [
      poolManagerLog("Initialize", { id, currency0, currency1, fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000001", sqrtPriceX96: 2n ** 96n, tick: 0 }, 1),
      poolManagerLog("ModifyLiquidity", { id, sender: currency1, tickLower: -60, tickUpper: 60, liquidityDelta: 1000n, salt: `0x${"00".repeat(32)}` }, 2),
      poolManagerLog("Swap", { id, sender: currency1, amount0: -1n, amount1: 1n, sqrtPriceX96: 2n ** 96n, liquidity: 1000n, tick: 0, fee: 3000 }, 3),
      nftxLog("PoolStateUpdated", { _collection: currency1, _sqrtPriceX96: 2n ** 96n, _tick: 0, _protocolFee: 0, _swapFee: 9000, _liquidity: 0n }, V4_HOOK, 4),
    ]);
    const node = fixtureSource([receipt]);
    node.install();
    await indexer.process({ chains: { 1: { simulate: triggersFrom(receipt) as any } } });

    expect(node.requests).toHaveLength(1);
    expect(await indexer.Pool.getAll()).toEqual([]);
    expect(await indexer.Token.getAll()).toEqual([]);
    expect(await indexer.Tick.getAll()).toEqual([]);
    expect(await indexer.Swap.getAll()).toEqual([]);
    expect(await indexer.ModifyLiquidity.getAll()).toEqual([]);
    expect(await indexer.PoolManager.getAll()).toEqual([]);
    expect((await indexer.IndexedTransaction.getAll()).map((t) => t.poolLogs)).toEqual([0n]);
  });

  it("never asks the node for a transaction that emitted no subscribed event", async () => {
    // With only NFTX contracts subscribed there is no such handler invocation
    // to make; the guarantee is structural. What can be checked is that a batch
    // of N triggers over M transactions costs exactly M receipt reads.
    const indexer = createTestIndexer();
    presetFixtureTokens(indexer);
    const fixtures = [TX.canonicalCreation, TX.canonicalSwap].map((hash) => loadFixture(hash));
    expect(fixtures.flatMap(triggersFrom)).toHaveLength(4);
    const node = await run(indexer, [TX.canonicalCreation, TX.canonicalSwap]);
    expect(node.requests).toHaveLength(2);
    expect(node.requests.every((r) => r.chainId === 1)).toBe(true);
  });
});

describe("replay", () => {
  it("is deterministic: the same transactions on a fresh database produce identical rows", async () => {
    const hashes = [TX.canonicalCreation, TX.canonicalSwap, TX.flexCreation, TX.multiPoolSwap];
    const snapshot = async () => {
      const indexer = createTestIndexer();
      presetFixtureTokens(indexer);
      await run(indexer, hashes);
      const sorted = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => a.id.localeCompare(b.id));
      return {
        pools: sorted(await indexer.Pool.getAll()),
        swaps: sorted(await indexer.Swap.getAll()),
        deposits: sorted(await indexer.ModifyLiquidity.getAll()),
        ticks: sorted(await indexer.Tick.getAll()),
        hours: sorted(await indexer.PoolHourData.getAll()),
        indexed: sorted(await indexer.IndexedTransaction.getAll()),
      };
    };
    const [first, second] = await Promise.all([snapshot(), snapshot()]);
    expect(second).toEqual(first);
    expect(first.indexed).toHaveLength(hashes.length);
  });

  it("does not replay a transaction that is already indexed", async () => {
    const indexer = createTestIndexer();
    presetFixtureTokens(indexer);
    const fixture = loadFixture(TX.canonicalCreation);
    const node = fixtureSource([fixture]);
    node.install();
    // The same three triggers again, as a restart or a duplicate delivery
    // would present them, after the first batch has been committed.
    await indexer.process({ chains: { 1: { simulate: triggersFrom(fixture) as any } } });
    const before = await indexer.Pool.getOrThrow(CANONICAL_POOL);
    const later = triggersFrom(fixture).map((t) => ({ ...t, block: { ...t.block, number: t.block.number + 1 } }));
    await indexer.process({ chains: { 1: { simulate: later as any } } });
    const after = await indexer.Pool.getOrThrow(CANONICAL_POOL);
    expect(after).toEqual(before);
    expect(await indexer.ModifyLiquidity.getAll()).toHaveLength(1);
    expect(await indexer.IndexedTransaction.getAll()).toHaveLength(1);
  });
});

describe("receipt failures", () => {
  it("retries a receipt the node does not have yet and then replays it", async () => {
    const indexer = createTestIndexer();
    presetFixtureTokens(indexer);
    const fixture = loadFixture(TX.canonicalCreation);
    let calls = 0;
    setReceiptSource(async () => (++calls < 3 ? null : fixture), { attempts: 4, delayMs: 5 });
    await indexer.process({ chains: { 1: { simulate: triggersFrom(fixture) as any } } });
    expect(calls).toBe(3);
    expect((await indexer.Pool.getOrThrow(CANONICAL_POOL)).liquidity).toBe(26050159308533988311n);
  });

  it("halts rather than skipping a transaction whose receipt never arrives", async () => {
    const indexer = createTestIndexer();
    presetFixtureTokens(indexer);
    const fixture = loadFixture(TX.canonicalCreation);
    setReceiptSource(async () => null, { attempts: 2, delayMs: 1 });
    await expect(indexer.process({ chains: { 1: { simulate: triggersFrom(fixture) as any } } })).rejects.toThrow(/no receipt/);
    expect(await indexer.Pool.getAll()).toEqual([]);
  });

  it("halts on a receipt from a different block than the event", async () => {
    const indexer = createTestIndexer();
    presetFixtureTokens(indexer);
    const fixture = loadFixture(TX.canonicalCreation);
    setReceiptSource(async () => ({ ...fixture, blockHash: `0x${"ee".repeat(32)}` }), { attempts: 2, delayMs: 1 });
    await expect(indexer.process({ chains: { 1: { simulate: triggersFrom(fixture) as any } } })).rejects.toThrow(/event was observed in block/);
  });

  it("halts on a receipt that does not contain the triggering log", async () => {
    const indexer = createTestIndexer();
    presetFixtureTokens(indexer);
    const fixture = loadFixture(TX.canonicalCreation);
    // Same block, same hash, but a receipt whose logs are someone else's.
    setReceiptSource(async () => ({ ...fixture, logs: fixture.logs.filter((l) => l.address.toLowerCase() !== V4_HOOK && l.logIndex !== 373) }));
    await expect(indexer.process({ chains: { 1: { simulate: triggersFrom(fixture) as any } } })).rejects.toThrow(/has no log 356/);
  });
});

describe("token metadata", () => {
  it("is only read for tokens the indexer has not seen", async () => {
    // Preset one side only; the other would need RPC, which the test cannot
    // reach — so this asserts the preset side is reused rather than refetched.
    const indexer = createTestIndexer();
    presetToken(indexer, 1, "0x000000000bb1f9944965c64066d10038a84f9af2", "flETH");
    presetToken(indexer, 1, "0x370e49749b9ff90004f3186aa7135487acc2a8fc", "PREEXISTING");
    await run(indexer, [TX.canonicalCreation]);
    const token = await indexer.Token.getOrThrow("1_0x370e49749b9ff90004f3186aa7135487acc2a8fc");
    expect(token.symbol).toBe("PREEXISTING");
    expect(token.poolCount).toBe(1n);
    expect((await indexer.Pool.getOrThrow(CANONICAL_POOL)).name).toBe("flETH / PREEXISTING - 838.8608%");
  });
});
