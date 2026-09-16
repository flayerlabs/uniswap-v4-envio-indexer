/*
 * GENERATED FILE — do not edit by hand.
 *
 * The NFTX pool ids the Swap and ModifyLiquidity handlers filter on. Regenerate
 * with `pnpm generate:pool-ids` after a launch, then redeploy. Read it through
 * `nftxPoolIds()` in ./nftxPools, which also honours ENVIO_NFTX_EXTRA_POOL_IDS.
 *
 * Generated 2026-09-16 from https://indexer.hyperindex.xyz/e1271b7/v1/graphql
 * Hooks seen: 0xaa49adadd33c5e953b645567afb10cbbba63afc4, 0xc26a5cb51b1818f62a4c6693a9a1fedb3340efc4
 *
 * A chain absent from this map (or present with an empty list) has no NFTX
 * pools, and its Swap / ModifyLiquidity events are skipped entirely.
 */
export const NFTX_POOL_IDS: Record<number, readonly string[]> = {
  // 6 pools (5 canonical, 1 flex)
  1: [
    "0x0e660964910a5c4af75309dba8f547a5a4303ac416a3ea54c1a3388cc5f32c91",
    "0x2fab92c6633a3538a3a9025f256e18a4c3925bacb2d66b88f7c03f072ecac7f3",
    "0x365b5b4b72f878ea36330db7191026614bef4d49d9ee645925594912fdfe2831",
    "0x3fdda4b3a94ff01928aef408251738b8190e73a990112235fbac6f9af4eb86dc",
    "0x87b6681f23e615792599a64be55151b0bea86daa42f357ddd2a3eaaee705f569",
    "0xc5dc916d83467b3a2a12f13d16ac66d4bd7c96866b6e6dc644ae2405216d06b4",
  ],
  // 4 pools (4 canonical, 0 flex)
  4663: [
    "0x00b3c41184fbd685b23efff9f72c4b2f9a61cf088ee165da8f2f8ee7ff3dd756",
    "0x77d86501db457ee55d9ab69a86a8debe099b031a889cefb6b48238a427b8807b",
    "0xc85fc8f45f79cc23b5327c59611f463721a73b55a48c40dfd0a3e1a74f79416e",
    "0xcf08c985e82f49de2440073626d8a69c75bf29f4086d7c678a6fbbda60161efb",
  ],
  // 14 pools (14 canonical, 0 flex)
  11155111: [
    "0x07b318d9ba389e3b6e70df82ddbbc4f8dbf54c6811f0b184f6ea173c235836c6",
    "0x1fa9baeb3bb67180e0375dcbb107e558e079d9466b925c8cc1b07d2309162946",
    "0x209b92c9dbabd0f121589ce6e6eee4c3adcaf8c13b2f86cf8c1eaf8a7a6352e1",
    "0x26da384232f647be5ea80b891876e8f445552ac71ea08d9b497463775b6ec7d4",
    "0x3af8004bf0b178fc2d93b13c2274eb3f94a956f948767db3e541224f666bc9b0",
    "0x3b309e358636775316965fbf3c33f956c1beca4f0600dbb7217d42aa2e4a2ac8",
    "0x66307037ec74f64d1dd4e25bd492136d2aa963e49794d4421d7a511d135b6809",
    "0x7534ae664b12f94fff0dd9213764396c19d744b9ab85667edc71eb3232c1bff0",
    "0x8eb88aba48839fbf784d85ed5aa7047c9ae8f2b39939fc04361910b26edb0555",
    "0xc65339e64f9b6938e79c7d1622b0a2cc4cf45ee66c6f9d7d10a1e8a365dce54d",
    "0xcbbd7e26b27e86df06cc44a08565526ffd28c374ce3a2f5699d322d3a80dd060",
    "0xd0522fe2b4a87e67a6946fbea23e05cfdeb91b411b6dcdb3164c0fbf4405e154",
    "0xd2ce004a38a3cf09be2902a77fb6aab2a90dc4d85abe1f10460aea800795d334",
    "0xf14f4aa34093551cd6c6ca739e1b80af651141faabdc89bbf4eb59272492690b",
  ],
};
