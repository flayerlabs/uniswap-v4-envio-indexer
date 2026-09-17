import { expect, it } from "vitest";
import { createTestIndexer } from "envio";
it("replays Sepolia creations and the swaps that follow over the new default RPC", async () => {
  const indexer = createTestIndexer();
  await indexer.process({ chains: { 11155111: { startBlock: 11563255, endBlock: 11563300 } } });
  const indexed = await indexer.IndexedTransaction.getAll();
  const pools = await indexer.Pool.getAll();
  const swaps = await indexer.Swap.getAll();
  const deposits = await indexer.ModifyLiquidity.getAll();
  console.error("SEPOLIA indexed", indexed.length, "pools", pools.length, "swaps", swaps.length, "deposits", deposits.length,
    "poolLogs", indexed.reduce((n, t) => n + Number(t.poolLogs), 0),
    "tvl", pools.map((p) => [p.name, p.totalValueLockedToken0.toString(), p.totalValueLockedToken1.toString(), Number(p.txCount)]));
  expect(pools.length).toBeGreaterThan(0);
  expect(swaps.length).toBeGreaterThan(0);
  expect(pools.every((p) => p.totalValueLockedToken0.gt(0) && p.totalValueLockedToken1.gt(0))).toBe(true);
}, 400000);
