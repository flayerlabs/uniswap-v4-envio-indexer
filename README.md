# Uniswap V4 Indexer

[![Discord](https://img.shields.io/badge/Discord-Join%20Chat-7289da?logo=discord&logoColor=white)](https://discord.com/invite/envio)

A multichain Uniswap V4 indexer built with [Envio HyperIndex](https://docs.envio.dev/docs/HyperIndex/overview).

This is Flayer's fork of [enviodev/uniswap-v4-indexer](https://github.com/enviodev/uniswap-v4-indexer) (which powers [v4.xyz](https://v4.xyz)). It is narrowed to serve NFTX's pool data: it indexes the seven chains NFTX v4 is deployed on, each from the block the NFTX protocol landed there, reads only the pools on NFTX's own hooks, and it is the sole source of Uniswap v4 volume, price, OHLC and swap data for the NFTX API — there is no Graph subgraph behind it.

![v4.xyz Dashboard](./v4.gif)

## What This Indexes

Nothing is read from a Uniswap contract directly. The indexer subscribes only to
NFTX's own contracts — the Locker and the two hooks — and treats each of their
events as a trigger: "this transaction touched a pool on one of our hooks". The
handler then fetches that transaction's receipt (once, cached, at most five
receipts per second) and replays the `PoolManager` `Initialize`,
`ModifyLiquidity` and `Swap` logs in it, in log order, keeping only pools whose
hook is a deployed NFTX hook (`src/utils/nftxHooks.ts`).

**Subscribed events (config.yaml):**
- `Locker.CollectionInitialized` — canonical pool creation
- `NFTXV4Hook.PoolStateUpdated` — emitted after initialize, swap, add and remove on every canonical pool
- `NFTXFlexHook.FlexPoolInitialized` — flex pool creation
- `NFTXFlexHook.FlexPoolStateUpdated` — emitted after swap, add and remove on every flex pool

**Replayed from receipts (src/handlers/hookActivity.ts):**
- `PoolManager.Initialize` — creates the `Pool`, its `Token`s and opening candles; rejected before any read for a foreign hook
- `PoolManager.ModifyLiquidity` — reserves, ticks, in-range liquidity, a `ModifyLiquidity` row
- `PoolManager.Swap` — reserves, price, token volume and fees, a `Swap` row, the hour/day candles

Every row keeps the original transaction hash, log index, block timestamp and
sender: `sender` is the PoolManager log's, `origin` is the receipt's `from`.
An `IndexedTransaction` row per replayed transaction makes the second and later
triggers in one transaction no-ops and is rolled back with everything else on a
reorg.

Why this shape: the `PoolManager` is a chain-wide singleton. Its
`Swap`/`ModifyLiquidity` logs carry no hook and its `Initialize` carries the
hook only in the data, so subscribing to it means ingesting every pool on the
chain (and, on RPC-only Arc, fetching every foreign transaction) to keep a
handful. Our hooks emit a state event after every action on every pool they
serve, from one fixed address per chain, so those events are a complete index
of the activity that matters. A new pool on a deployed hook is picked up from
its first transaction with no allowlist and no redeploy.

**Not indexed any more:** `PositionManager` `Transfer`/`Subscription`/
`Unsubscription`. They were chain-wide (an ERC-721 `Transfer` cannot be
topic-filtered to NFTX positions) and nothing NFTX serves reads the
`Position`/`Transfer`/`Subscribe`/`Unsubscribe` rows — the API takes LP
ownership and state from the StateView contract. The types remain in the schema
so existing queries resolve; the tables are empty on a fresh deploy.

**Chains and start blocks:**

| Chain | ID | `start_block` | Why |
|---|---|---|---|
| Ethereum | 1 | 25638238 | NFTX v3-generation deploy (25638238-25638272) |
| Ethereum Sepolia | 11155111 | 11465794 | NFTX deploy (11465794-11465822) |
| Robinhood | 4663 | 35354494 | 100 below NFTX deploy (35354594-35354959) |
| Ink | 57073 | 54328901 | 100 below NFTX deploy (54329001-54329039) |
| Base | 8453 | 51475363 | 100 below the NFTX redeploy onto the shared CREATE3 book (51475463-51475487, 2026-09-18); the earlier pre-CREATE3 generation is not indexed |
| Arc | 5042 | 21129174 | NFTX core deploy (21129174-21129248); RPC sync, no HyperSync |
| Arbitrum One | 42161 | 498892278 | 100 below NFTX deploy (498892378-498892454) |

Blocks match the NFTX indexer's pins so the two stay aligned. Only pools NFTX
initialises matter here and all of them are created after the protocol lands.

**USD and ETH valuation fields are always zero, by design.** The upstream
pricing graph (`derivedETH`, whitelist pools, the stablecoin anchor pool)
needed a chain-wide view of pools the indexer no longer has, and NFTX's
consumers price the raw token amounts themselves. `amountUSD`, `volumeUSD`,
`feesUSD`, `totalValueLockedETH/USD`, `tvlUSD`, `Bundle.ethPriceUSD` and the
`HookStats`/`PoolManager` USD and ETH totals are written as 0 and kept only so
existing queries resolve. Consumers read the token-denominated fields:
`sqrtPrice`, `token0Price` / `token1Price`, `volumeToken0` / `volumeToken1`,
`collectedFeesToken0` / `collectedFeesToken1`, `totalValueLockedToken0` /
`totalValueLockedToken1`, and the OHLC columns on the interval buckets.

## What's Indexed

The GraphQL API exposes pool statistics, swap history, liquidity changes and
per-pool hour and day aggregates for every NFTX pool across all supported chains.

`PoolHourData` and `PoolDayData` are ported field-for-field from the upstream
[Uniswap V4 Subgraph](https://github.com/Uniswap/v4-subgraph) (`PoolDayData` /
`PoolHourData` plus `src/utils/intervalUpdates.ts`), so a consumer reads them
exactly as it read the subgraph's: `open`/`high`/`low`/`close` are `token0Price`
(token1 per token0), volumes are per-bucket sums, everything else is an
end-of-period snapshot. They exist because the hosted Hasura endpoint exposes no
`_aggregate` root fields and clamps every root field to 1000 rows, which makes
reconstructing windowed volume from raw `Swap` rows lossy on busy pools.

## Prerequisites

- [Node.js](https://nodejs.org/en/download/current) v24 or newer
- [pnpm](https://pnpm.io/installation) v8 or newer
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)

## Quick Start

```bash
# Install dependencies
pnpm i

# Run locally (starts indexer + GraphQL API at http://localhost:8080)
pnpm envio dev
```

The Hasura console is available at [http://localhost:8080](http://localhost:8080) where you can explore and query indexed data using GraphQL.

## Regenerate Files

If you modify `config.yaml` or `schema.graphql`:

```bash
pnpm codegen
```

## RPC Configuration

RPC endpoints for each chain can be customized via environment variables prefixed with `ENVIO_`. See `.env.example` for the full list:

```bash
ENVIO_MAINNET_RPC_URL=https://your-mainnet-node
ENVIO_ARBITRUM_RPC_URL=https://your-arbitrum-node
```

These serve two effects: `getTransactionReceipt` (one
`eth_getTransactionReceipt` per NFTX transaction, rate-limited to 5/s, cached)
and `getTokenMetadata` (name/symbol/decimals via a viem multicall, once per new
token). Event ingestion itself goes through HyperSync on every chain except Arc,
which HyperSync does not serve and which `config.yaml` syncs over
`ENVIO_RPC_URL_5042` instead. Every network in `config.yaml` must have a case in
`getRpcUrl` (`src/utils/tokenMetadata.ts`) — without one, the first NFTX
transaction on that chain throws from the handler and the chain's sync halts.
`src/rpcUrls.test.ts` enforces this.

A receipt that the node does not have, or has for a different block (a lagging
node, or the far side of a reorg), is retried with backoff for ~15s and then
thrown; HyperIndex does not retry effects, so the chain halts rather than skip a
transaction that is known to have touched an NFTX pool. Transport errors are
retried by the viem client for ~63s before that.

## Querying the Data

Once running, query the GraphQL API to explore pool and swap data:

```graphql
{
  Pool(limit: 10, order_by: {volumeUSD: desc}) {
    id
    token0 { symbol }
    token1 { symbol }
    volumeUSD
    totalValueLockedUSD
  }
}
```

## Built With

- [Envio HyperIndex](https://docs.envio.dev/docs/HyperIndex/overview) - multichain indexing framework
- [HyperSync](https://docs.envio.dev/docs/HyperSync/overview) - high-performance blockchain data retrieval
- Based on the [Uniswap V4 Subgraph](https://github.com/Uniswap/v4-subgraph) schema (pricing and core entity logic)

## Documentation

- [HyperIndex Docs](https://docs.envio.dev/docs/HyperIndex/overview)
- [Uniswap V4 Multichain Indexer Reference](https://docs.envio.dev/docs/HyperIndex/example-uniswap-v4-multi-chain-indexer)
- [Uniswap V4 Docs](https://docs.uniswap.org/contracts/v4/overview)

## Contributing

Upstream is [enviodev/uniswap-v4-indexer](https://github.com/enviodev/uniswap-v4-indexer); changes that are not NFTX-specific belong there.

## Support

- [Discord community](https://discord.com/invite/envio)
- [Envio Docs](https://docs.envio.dev)

## Testing

```bash
pnpm test                          # everything; the two live files need ENVIO_API_TOKEN
pnpm exec vitest run --exclude src/reserves.test.ts --exclude src/indexer.test.ts   # offline only
ENVIO_BENCHMARK=1 pnpm exec vitest run test/benchmark.test.ts                       # per-chain replay timings
```

`src/hookActivity.test.ts` drives the handlers with real mainnet receipts stored
under `test/fixtures/receipts/` (served through the `setReceiptSource` seam in
`src/utils/transactionReceipt.ts`) and covers canonical and flex creation, both
token orderings, an arbitrary pair token with no price, liquidity removal, a
transaction that swaps a foreign pool and two NFTX pools at once, duplicate
triggers, deterministic replay, and receipt retry/mismatch handling.

`src/reserves.test.ts` and `src/indexer.test.ts` replay the same transactions
live. The MILADY/WETH position 406489 regression (block 25997033, transaction
`0xf5839651…6a4f7`) must recover 1.994991739332266005 MILADY and
1.695742978432426104 WETH at creation and retain its later swaps; the canonical
creation regression verifies the later Locker event cannot erase the seed
deposit.

### Replay required when switching to this ingestion model

Deploy into a fresh database and replay from each configured start block. The
previous model's rows are compatible, but a restart at the chain head would
leave every earlier `IndexedTransaction` absent and is not a supported upgrade
path. Before switching API consumers, verify synchronization and reserves on
the replacement, then promote it and point the API at it.
