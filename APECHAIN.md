# ApeChain activation

ApeChain (33139) is staged behind `src/utils/apechain-deployment.ts`, which remains null until the actual PoolManager has been deployed and verified. In the Flayer workspace, use `Frontend/nftx-v4-frontend/scripts/configure-apechain.mjs` to generate this file and the `config.yaml` chain block from confirmed receipts. The complete deployment sequence is in the sibling `Flayer/Contracts/APECHAIN.md`.

The generated network indexes PoolManager and PositionManager. Run codegen and build after generating its configuration. Both contracts must be indexed from their receipt-derived start block before clients are enabled.

The native asset is APE and the wrapped asset is WAPE at `0x48b62137edfa95a428d35c09e44256a739f6b557`, each with 18 decimals. WAPE has a static metadata override and is the native pricing leg. No stablecoin reference pool has been invented: indexer USD fields can remain unavailable/zero until one is explicitly configured. NFTX's API consumes raw token-side amounts and supplies independent APE/USD pricing; do not consume this indexer's unconfigured USD fields as measured ApeChain dollar volume.

WAPE rebases increase ERC-20 balances without emitting pool swap/fee events. This indexer does not attribute those increases to position fees or APR.

Validation: `pnpm build` and `pnpm exec vitest run --exclude src/indexer.test.ts`. The two replay tests in `src/indexer.test.ts` additionally need a valid `ENVIO_API_TOKEN`; run those with deployment credentials in the normal CI environment.
