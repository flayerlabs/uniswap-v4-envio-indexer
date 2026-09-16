/*
 * Regenerates src/utils/nftxPoolIds.ts — the allowlist of NFTX pool ids the
 * Initialize, Swap and ModifyLiquidity handlers filter on.
 *
 *   pnpm generate:pool-ids
 *
 * Source of truth is the NFTX indexer, which records each pool's key straight
 * off Locker.CollectionInitialized (and the flex hook's own initialisation), so
 * currency ordering and the hook address are already whatever the chain says
 * they are. Every id is re-derived from its recorded components as a check; a
 * mismatch fails the run rather than writing a list that would silently drop a
 * pool's volume.
 *
 * Run this after any launch and redeploy the indexer. Until you do, a new pool's
 * AMM volume is missing — the redeploy re-indexes from the chain's start block
 * through the filter, so the history is backfilled rather than lost.
 */
import { writeFileSync } from "node:fs";
import { nftxPoolId } from "../src/utils/nftxPoolKey.ts";

const ENDPOINT =
  process.env.NFTX_INDEXER_URL ?? "https://indexer.hyperindex.xyz/e1271b7/v1/graphql";
const OUT = new URL("../src/utils/nftxPoolIds.ts", import.meta.url);

const gql = async (query) => {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`${ENDPOINT} returned ${res.status}`);
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
};

const { Pool: pools } = await gql(`{
  Pool(limit: 1000) {
    chainId poolId canonical collectionToken pairToken hooks fee tickSpacing currency0 currency1
  }
}`);

// Collection.poolId covers anything predating the Pool entity.
const { Collection: collections } = await gql(`{
  Collection(where: {poolId: {_is_null: false}}, limit: 1000) { chainId poolId }
}`);

const problems = [];
const byChain = new Map();

for (const p of pools) {
  const derived = nftxPoolId({
    collectionToken: p.collectionToken,
    pairToken: p.pairToken,
    hooks: p.hooks,
    fee: Number(p.fee),
    tickSpacing: Number(p.tickSpacing),
  });
  if (derived.toLowerCase() !== p.poolId.toLowerCase()) {
    problems.push(
      `chain ${p.chainId} pool ${p.poolId}: derived ${derived} from ` +
        `(${p.collectionToken}, ${p.pairToken}, fee ${p.fee}, spacing ${p.tickSpacing}, hook ${p.hooks})`,
    );
  }
  if (p.currency0 && p.currency1 && BigInt(p.currency0) >= BigInt(p.currency1)) {
    problems.push(`chain ${p.chainId} pool ${p.poolId}: currency0 >= currency1`);
  }
  byChain.set(p.chainId, (byChain.get(p.chainId) ?? new Set()).add(p.poolId.toLowerCase()));
}

for (const c of collections) {
  byChain.set(c.chainId, (byChain.get(c.chainId) ?? new Set()).add(c.poolId.toLowerCase()));
}

if (problems.length) {
  console.error("Refusing to write a list that does not re-derive:");
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}

const chains = [...byChain.keys()].sort((a, b) => a - b);
const hooks = [...new Set(pools.map((p) => p.hooks.toLowerCase()))];

const body = chains
  .map((chainId) => {
    const ids = [...byChain.get(chainId)].sort();
    const canonical = pools.filter((p) => p.chainId === chainId && p.canonical).length;
    const flex = pools.filter((p) => p.chainId === chainId && !p.canonical).length;
    return (
      `  // ${ids.length} pool${ids.length === 1 ? "" : "s"}` +
      (canonical || flex ? ` (${canonical} canonical, ${flex} flex)` : "") +
      `\n  ${chainId}: [\n${ids.map((id) => `    "${id}",`).join("\n")}\n  ],`
    );
  })
  .join("\n");

writeFileSync(
  OUT,
  `/*
 * GENERATED FILE — do not edit by hand.
 *
 * The NFTX pool ids the Initialize, Swap and ModifyLiquidity handlers filter on. Regenerate
 * with \`pnpm generate:pool-ids\` after a launch, then redeploy. Read it through
 * \`nftxPoolIds()\` in ./nftxPools, which also honours ENVIO_NFTX_EXTRA_POOL_IDS.
 *
 * Generated ${new Date().toISOString().slice(0, 10)} from ${ENDPOINT}
 * Hooks seen: ${hooks.join(", ")}
 *
 * A chain absent from this map (or present with an empty list) has no NFTX
 * pools, and its Initialize / Swap / ModifyLiquidity events are skipped entirely.
 */
export const NFTX_POOL_IDS: Record<number, readonly string[]> = {
${body}
};
`,
);

console.log(`Wrote ${chains.length} chains:`);
for (const chainId of chains) console.log(`  ${chainId}: ${byChain.get(chainId).size} pools`);
console.log(`All ${pools.length} recorded pools re-derived from their components.`);
