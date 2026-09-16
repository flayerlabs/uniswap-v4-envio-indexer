# Uniswap V4 Indexer

[![Discord](https://img.shields.io/badge/Discord-Join%20Chat-7289da?logo=discord&logoColor=white)](https://discord.com/invite/envio)

A multichain Uniswap V4 indexer built with [Envio HyperIndex](https://docs.envio.dev/docs/HyperIndex/overview).

This is Flayer's fork of [enviodev/uniswap-v4-indexer](https://github.com/enviodev/uniswap-v4-indexer) (which powers [v4.xyz](https://v4.xyz)). It is narrowed to serve NFTX's pool data: it indexes the five chains NFTX v4 is deployed on, each from the block the NFTX protocol landed there, and it is the sole source of Uniswap v4 volume, price, OHLC and swap data for the NFTX API — there is no Graph subgraph behind it.

![v4.xyz Dashboard](./v4.gif)

## What This Indexes

This indexer tracks all key events from Uniswap V4 `PoolManager` and `PositionManager` contracts across multiple chains:

**Events handled:**
- `PoolManager.Initialize` - pool creation with fee, tick spacing, and hooks
- `PoolManager.Swap` - all swaps with amounts, price, liquidity, and transaction details
- `PoolManager.ModifyLiquidity` - liquidity additions and removals
- `PositionManager.Transfer` / `Subscription` / `Unsubscription` - position ownership and subscriptions

Several further `PoolManager` events (`Donate`, `Approval`, `OperatorSet`, ERC-6909 `Transfer`, the protocol-fee events) are declared in `config.yaml` and decoded, but have no handler and write nothing.

**Chains and start blocks:**

| Chain | ID | `start_block` | Why |
|---|---|---|---|
| Ethereum | 1 | 25638238 | NFTX v3-generation deploy (25638238-25638272) |
| Ethereum Sepolia | 11155111 | 11465794 | NFTX deploy (11465794-11465822) |
| Robinhood | 4663 | 35354494 | 100 below NFTX deploy (35354594-35354959) |
| Ink | 57073 | 54328901 | 100 below NFTX deploy (54329001-54329039) |
| Arbitrum One | 42161 | 498892278 | 100 below NFTX deploy (498892378-498892454) |

Blocks match the NFTX indexer's pins so the two stay aligned. Only pools NFTX
initialises matter here and all of them are created after the protocol lands, so
starting at the PoolManager deployment (up to ~200M blocks earlier on Arbitrum)
would buy nothing. Events for pools initialised before the start block are
skipped by the handlers — the `Pool` entity is absent and they early-return —
rather than mis-indexed.

**USD values are always zero, by design.** Every chain's stablecoin/native
pricing anchor pool (`stablecoinWrappedNativePoolId` in `src/utils/chains.ts`)
predates its start block, so no `Pool` row exists for it, `getNativePriceInUSD`
returns 0 and `Bundle.ethPriceUSD` stays 0. Every USD-denominated field follows.
Consumers read the ETH-denominated fields instead: `sqrtPrice`, `token0Price` /
`token1Price`, `volumeToken0` / `volumeToken1`, `totalValueLockedToken0` /
`totalValueLockedToken1`, and the OHLC columns on the interval buckets.

## What's Indexed

The GraphQL API exposes pool statistics, swap history, per-pool hour and day
aggregates, and liquidity positions across all supported chains.

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

These are used only by the `getTokenMetadata` effect (name/symbol/decimals via a
viem multicall); indexing itself goes through HyperSync, which serves all five
chains natively.

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

## The NFTX pool allowlist

The Uniswap `PoolManager` is a singleton: its `Swap` and `ModifyLiquidity` events
carry every v4 pool on the chain, not just ours. Measured against live data, NFTX
pools are **0.007%** of mainnet swaps and **0.003%** of Robinhood's, and those two
events are ~99.8% of everything this indexer would otherwise ingest.

Both handlers therefore filter on an allowlist of NFTX pool ids. `id` is an
indexed topic, so the list is pushed down into the HyperSync/RPC query — the rest
is never delivered to the indexer and never counted against the event-processing
quota.

### Refreshing it after a launch

```sh
pnpm generate:pool-ids   # rewrites src/utils/nftxPoolIds.ts
```

The generator reads the NFTX indexer, which records each pool's key straight off
`Locker.CollectionInitialized`, then **re-derives every id from its recorded
components** and refuses to write if one disagrees. That check is there because
the derivation has two traps: Uniswap v4 sorts the pair by address, so the
collection token lands on `currency0` about half the time (12 of our 24 pools as
of writing), and the hook is part of the key — canonical pools use `NFTXV4Hook`,
flex pools use `NFTXFlexHook` with a whitelisted pair token instead of the chain's
quote token. Taking the ids from the indexer rather than assuming a shape is what
makes both cases fall out for free.

Commit the regenerated file and redeploy.

### Being late is not the same as losing data

A redeploy re-indexes from each chain's `start_block` *through this filter*, so a
pool added to the list later is backfilled from its own `Initialize`. A stale list
delays a collection's AMM volume; it does not drop it.

To index a pool before the next regeneration — a launch that just happened, say —
set the override on the deployment, no code change needed:

```sh
ENVIO_NFTX_EXTRA_POOL_IDS="1:0xabc…,0xdef…;11155111:0x123…"
```

A chain with no entries at all (deployed but nothing launched — Ink, Arbitrum One
and Arc today) skips `Swap` and `ModifyLiquidity` outright.

