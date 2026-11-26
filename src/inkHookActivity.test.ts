/** Real Thinkers receipts: unified Ink hook creation and a subsequent routed swap. */
import { afterEach, describe, expect, it } from "vitest";
import { createTestIndexer } from "envio";
import { fixtureSource, loadFixture, presetToken, triggersFrom } from "../test/helpers/receipts";
import { setReceiptSource } from "./utils/transactionReceipt";

const CHAIN = 57073;
const HOOK = "0xc1595f4277c94fa15c397ecad787fc0072862fc4";
const POOL = "57073_0xddc32c9ba17620e87cf62d9d36f1b8ea70c421f36b0672cb5cccb3be2954137d";
const QUOTE = "0x4c1ae29c159838fc1b224636e28e086eb69101f7";
const COLLECTION_TOKEN = "0xc22727c038dae1f8c65ee381a25450e14cba30c3";
const CREATION = "0x9487c83aa3aa0eec678535c825dbe4a2800b8601cb454f7f9b7f8a0eb0746eb6";
const SWAP = "0x98ae0356246f5ed792b163cde81b5e1d6cfa5627ee3d9818d7502ae0d6ff486c";

const run = async (hashes: string[]) => {
  const indexer = createTestIndexer();
  presetToken(indexer, CHAIN, QUOTE, "wQQQx");
  presetToken(indexer, CHAIN, COLLECTION_TOKEN, "THINK");
  const fixtures = hashes.map((hash) => loadFixture(hash, CHAIN));
  const node = fixtureSource(fixtures);
  node.install();
  for (const fixture of fixtures) {
    await indexer.process({ chains: { 57073: { simulate: triggersFrom(fixture) as any } } });
  }
  return { indexer, node };
};

afterEach(() => setReceiptSource(undefined));

describe("Ink unified NFTXHook", () => {
  it("creates Thinkers and replays both seed deposits and the launch swap once", async () => {
    const { indexer, node } = await run([CREATION]);
    expect(node.requests).toHaveLength(1);
    expect(await indexer.IndexedTransaction.getAll()).toMatchObject([{
      id: `${CHAIN}_${CREATION}`,
      blockNumber: 62174387n,
      triggerLogIndex: 89n, // PoolInitialized, before the PoolManager Initialize
      poolLogs: 4n, // Initialize, two ModifyLiquidity, Swap
    }]);

    const pool = await indexer.Pool.getOrThrow(POOL);
    expect(pool.hooks.toLowerCase()).toBe(HOOK);
    expect(pool.token0).toBe(`${CHAIN}_${QUOTE}`);
    expect(pool.token1).toBe(`${CHAIN}_${COLLECTION_TOKEN}`);
    expect(pool.createdAtBlockNumber).toBe(62174387n);
    expect(pool.liquidity).toBe(220327952007685810279n);
    expect(pool.sqrtPrice).toBe(137341189185333645763361362702n);
    expect(pool.txCount).toBe(3n);
    expect((await indexer.ModifyLiquidity.getAll()).map((entry) => entry.logIndex)).toEqual([95n, 104n]);
    expect(await indexer.Swap.getAll()).toMatchObject([{
      transaction: CREATION,
      pool: POOL,
      logIndex: 125n,
      tick: 11003n,
      fee: 9000n,
    }]);
  });

  it("indexes subsequent activity and candles while excluding the route's foreign pools", async () => {
    const { indexer, node } = await run([CREATION, SWAP]);
    expect(node.requests.map((request) => request.hash)).toEqual([CREATION, SWAP]);
    expect(await indexer.IndexedTransaction.getAll()).toHaveLength(2);
    expect((await indexer.Pool.getAll()).map((pool) => pool.id)).toEqual([POOL]);
    const swaps = await indexer.Swap.getAll();
    expect(swaps).toHaveLength(2);
    const swap = swaps.find((entry) => entry.transaction === SWAP)!;
    expect(swap).toMatchObject({
      id: "57073_62174388_6",
      pool: POOL,
      logIndex: 6n,
      tick: 10811n,
      fee: 9000n,
    });
    // Swap entities store reserve deltas, the inverse of the caller deltas.
    expect(swap.amount0.toString()).toBe("0.255965986960661555");
    expect(swap.amount1.toString()).toBe("-0.74918325324278897");

    const pool = await indexer.Pool.getOrThrow(POOL);
    expect(pool.sqrtPrice).toBe(136030665000219846853040718869n);
    expect(pool.liquidity).toBe(231540593968098529805n);
    expect(pool.txCount).toBe(4n);
    expect(pool.volumeToken0.toString()).toBe("0.687521570680564016");
    expect(pool.volumeToken1.toString()).toBe("2.053350917799380649");
    const hours = await indexer.PoolHourData.getAll();
    const days = await indexer.PoolDayData.getAll();
    expect(hours).toHaveLength(1);
    expect(days).toHaveLength(1);
    for (const bucket of [...hours, ...days]) {
      expect(bucket.pool).toBe(POOL);
      expect(bucket.volumeToken0.toString()).toBe(pool.volumeToken0.toString());
      expect(bucket.volumeToken1.toString()).toBe(pool.volumeToken1.toString());
      expect(bucket.txCount).toBe(5n); // Initialize, two deposits and two swaps
    }
  });
});
