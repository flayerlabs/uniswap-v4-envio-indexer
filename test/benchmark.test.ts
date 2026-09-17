/**
 * Per-chain replay benchmark. Opt-in: `ENVIO_BENCHMARK=1 pnpm exec vitest run
 * test/benchmark.test.ts`. Needs ENVIO_API_TOKEN (HyperSync) and, for Arc, an
 * RPC that tolerates a sustained log scan (ENVIO_RPC_URL_5042).
 *
 * Each chain replays a representative range from its NFTX start block and
 * reports wall time, subscribed events, receipts replayed and rows written, so
 * a hosted replay can be sized before it is started. Assertions are deliberately
 * loose — the numbers are the output, not the pass condition — except that
 * every replayed receipt must belong to a transaction that emitted a subscribed
 * event, and no chain may produce a pool on a foreign hook.
 */
import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTestIndexer } from "envio";
import { NFTX_HOOKS } from "../src/utils/nftxHooks";

const enabled = process.env.ENVIO_BENCHMARK === "1";

/** [chainId, startBlock, blocks to replay]. Ranges start at each chain's config start_block. */
const RANGES: [number, number, number][] = [
  [1, 25638238, 60_000],
  [11155111, 11465794, 60_000],
  [4663, 35354494, 200_000],
  [57073, 54328901, 200_000],
  [42161, 498892278, 200_000],
  [5042, 21129174, Number(process.env.ENVIO_BENCHMARK_ARC_BLOCKS ?? 20_000)],
];

const report = (line: string) => {
  const file = process.env.ENVIO_BENCHMARK_REPORT;
  if (file) appendFileSync(file, line + "\n");
};

describe.runIf(enabled)("replay benchmark", () => {
  for (const [chainId, startBlock, blocks] of RANGES) {
    it(`chain ${chainId}: ${blocks} blocks from ${startBlock}`, async () => {
      const indexer = createTestIndexer();
      const started = Date.now();
      const result = await indexer.process({
        chains: { [chainId]: { startBlock, endBlock: startBlock + blocks - 1 } },
      });
      const elapsed = Date.now() - started;
      const events = result.changes.reduce((n, change) => n + change.eventsProcessed, 0);
      const rows = (name: string) => result.changes.reduce((n, change: any) => n + (change[name]?.sets?.length ?? 0), 0);
      const indexed = await indexer.IndexedTransaction.getAll();
      const pools = await indexer.Pool.getAll();
      const summary = {
        chainId,
        startBlock,
        blocks,
        ms: elapsed,
        subscribedEvents: events,
        receiptsReplayed: indexed.length,
        pools: pools.length,
        swaps: (await indexer.Swap.getAll()).length,
        liquidityChanges: (await indexer.ModifyLiquidity.getAll()).length,
        hourBucketWrites: rows("PoolHourData"),
      };
      report(JSON.stringify(summary));
      console.log(JSON.stringify(summary));

      // One replay per triggering transaction, never more.
      expect(indexed.length).toBeLessThanOrEqual(events);
      // Only our hooks.
      const hooks = NFTX_HOOKS[chainId]!;
      expect(pools.every((pool) => hooks.includes(pool.hooks.toLowerCase()))).toBe(true);
    }, 1_800_000);
  }
});
