/**
 * ApeChain Armory handlers, driven by simulated events (there is no NFTX
 * activity on ApeChain to replay yet).
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "vitest";
import { createTestIndexer, BigDecimal } from "envio";
import { encodeAbiParameters, numberToHex } from "viem";
import { ARMORY, armoryPoolId, computeArmoryPool, sortTokens } from "./utils/armory";

const PREINIT_PRICE = 2n ** 96n * 3n;
const PREINIT_TICK = 21_972n;

/**
 * A one-method JSON-RPC node for the slot0 read, the only RPC these handlers
 * make: a computed NFTX pool has no code on chain to read. The handlers run in
 * Envio's own module graph, so the effect is reached through its RPC URL.
 */
const startSlot0Node = async (): Promise<{ url: string; calls: Array<{ to: string; block: string }>; close: () => void }> => {
  const calls: Array<{ to: string; block: string }> = [];
  const result = encodeAbiParameters(
    [
      { type: "uint160" },
      { type: "int24" },
      { type: "uint16" },
      { type: "uint16" },
      { type: "uint16" },
      { type: "uint8" },
      { type: "bool" },
    ],
    [PREINIT_PRICE, Number(PREINIT_TICK), 0, 1, 1, 0, true],
  );
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body);
      if (method === "eth_call") calls.push({ to: params[0].to.toLowerCase(), block: params[1] });
      const reply =
        method === "eth_call"
          ? { result }
          : method === "eth_chainId"
            ? { result: "0x8173" }
            : { error: { code: -32601, message: method } };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, ...reply }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, calls, close: () => server.close() };
};

const APECHAIN = 33139;
const config = ARMORY[APECHAIN]!;
const START = 50_820_532; // after the ApeChain start_block (the NFTXArmory deployment)
const COLLECTION = "0x00000000000000000000000000000000000c0113";
const TOKEN = "0x0000000000000000000000000000000000000001"; // sorts below WAPE
const TRADER = "0x00000000000000000000000000000000000beef1";
const Q96 = 2n ** 96n;
type Hex = `0x${string}`;
const txOf = (n: number): { hash: Hex; from: Hex } => ({ hash: `0x${n.toString(16).padStart(64, "0")}`, from: TRADER });

const token = (id: string, symbol: string) => ({
  id: `${APECHAIN}_${id}`,
  chainId: BigInt(APECHAIN),
  symbol,
  name: symbol,
  decimals: 18n,
  totalSupply: 0n,
  volume: new BigDecimal("0"),
  volumeUSD: new BigDecimal("0"),
  untrackedVolumeUSD: new BigDecimal("0"),
  feesUSD: new BigDecimal("0"),
  txCount: 0n,
  poolCount: 0n,
  totalValueLocked: new BigDecimal("0"),
  totalValueLockedUSD: new BigDecimal("0"),
  totalValueLockedUSDUntracked: new BigDecimal("0"),
  derivedETH: new BigDecimal("0"),
  whitelistPools: [],
});

describe("ApeChain Armory pools", () => {
  it("registers the collection pool and applies Initialize, Mint, Swap and Burn", async (t) => {
    const indexer = createTestIndexer();
    // Preset token rows so no metadata RPC is needed for the synthetic token.
    indexer.Token.set(token(TOKEN, "COL"));
    indexer.Token.set(token(config.nativeToken, "WAPE"));

    const pool = computeArmoryPool(APECHAIN, TOKEN);
    await indexer.process({
      chains: {
        [APECHAIN]: {
          simulate: [
            {
              contract: "NFTXArmory",
              event: "MarketRegistered",
              srcAddress: config.market as Hex,
              block: { number: START, timestamp: 1_000 },
              params: { _collection: COLLECTION, _token: TOKEN },
            },
            {
              contract: "ArmoryV3Pool",
              event: "Initialize",
              srcAddress: pool as Hex,
              block: { number: START + 1, timestamp: 2_000 },
              transaction: txOf(1),
              logIndex: 0,
              params: { sqrtPriceX96: Q96, tick: 0n },
            },
            {
              contract: "ArmoryV3Pool",
              event: "Mint",
              srcAddress: pool as Hex,
              block: { number: START + 1, timestamp: 2_000 },
              transaction: txOf(1),
              logIndex: 1,
              params: {
                sender: config.market as Hex,
                owner: "0x75301ade925a7e7f47cb00de7324ff2efaf5306a",
                tickLower: -887_200n,
                tickUpper: 887_200n,
                amount: 10n ** 20n,
                amount0: 10n ** 20n,
                amount1: 10n ** 20n,
              },
            },
            {
              // Pool-side deltas: the pool received 1 WAPE (token1) and paid out ~0.98 token0.
              contract: "ArmoryV3Pool",
              event: "Swap",
              srcAddress: pool as Hex,
              block: { number: START + 2, timestamp: 3_000 },
              transaction: txOf(2),
              logIndex: 0,
              params: {
                sender: "0x4718992f1eaab6d8a0d3c02b6cbf25be497bc46b",
                recipient: TRADER,
                amount0: -(98n * 10n ** 16n),
                amount1: 10n ** 18n,
                sqrtPriceX96: (Q96 * 101n) / 100n,
                liquidity: 10n ** 20n,
                tick: 199n,
              },
            },
            {
              // The position manager's zero burn before a collect: not a liquidity change.
              contract: "ArmoryV3Pool",
              event: "Burn",
              srcAddress: pool as Hex,
              block: { number: START + 3, timestamp: 4_000 },
              transaction: txOf(3),
              logIndex: 0,
              params: {
                owner: "0x75301ade925a7e7f47cb00de7324ff2efaf5306a",
                tickLower: -887_200n,
                tickUpper: 887_200n,
                amount: 0n,
                amount0: 0n,
                amount1: 0n,
              },
            },
            {
              contract: "ArmoryV3Pool",
              event: "Burn",
              srcAddress: pool as Hex,
              block: { number: START + 3, timestamp: 4_000 },
              transaction: txOf(3),
              logIndex: 1,
              params: {
                owner: "0x75301ade925a7e7f47cb00de7324ff2efaf5306a",
                tickLower: -887_200n,
                tickUpper: 887_200n,
                amount: 10n ** 19n,
                amount0: 0n,
                amount1: 0n,
              },
            },
          ],
        },
      },
    });

    const [token0, token1] = sortTokens(APECHAIN, TOKEN);
    const registration = await indexer.ArmoryPool.getOrThrow(`${APECHAIN}_${pool}`);
    t.expect(registration.collection).toBe(COLLECTION);
    t.expect([registration.token0, registration.token1]).toEqual([token0, token1]);

    const poolRow = await indexer.Pool.getOrThrow(`${APECHAIN}_${armoryPoolId(pool)}`);
    t.expect(poolRow.hooks.toLowerCase()).toBe(config.market);
    t.expect(poolRow.feeTier).toBe(config.fee);
    t.expect(poolRow.tickSpacing).toBe(config.tickSpacing);
    t.expect(poolRow.name).toBe("COL / WAPE - 1%");
    t.expect(poolRow.sqrtPrice).toBe((Q96 * 101n) / 100n);
    t.expect(poolRow.tick).toBe(199n);
    // Mint +1e20, the swap reports 1e20 in range, the real burn removes 1e19.
    t.expect(poolRow.liquidity).toBe(9n * 10n ** 19n);
    t.expect(poolRow.volumeToken1.toString()).toBe("1");
    t.expect(poolRow.volumeToken0.toString()).toBe("0.98");

    const swaps = await indexer.Swap.getAll();
    t.expect(swaps).toHaveLength(1);
    // Stored pool-side, as on V4: the pool received token1 and paid token0.
    t.expect(swaps[0]!.amount1.toString()).toBe("1");
    t.expect(swaps[0]!.amount0.toString()).toBe("-0.98");
    t.expect(swaps[0]!.fee).toBe(config.fee);
    t.expect(swaps[0]!.origin.toLowerCase()).toBe(TRADER);

    const changes = await indexer.ModifyLiquidity.getAll();
    t.expect(changes.map((c) => c.amount).sort()).toEqual([-(10n ** 19n), 10n ** 20n].sort());
    t.expect(await indexer.Pool.getAll()).toHaveLength(1);
    // A log from any address that was not registered never reaches a handler at
    // all: Envio filters it by address first (the harness reports it as unrouted).
  }, 120_000);

  it("seeds a pool initialised before its registration from slot0 at the previous block", async (t) => {
    const node = await startSlot0Node();
    const saved = process.env.ENVIO_APECHAIN_RPC_URL;
    process.env.ENVIO_APECHAIN_RPC_URL = node.url;
    const indexer = createTestIndexer();
    indexer.Token.set(token(TOKEN, "COL"));
    indexer.Token.set(token(config.nativeToken, "WAPE"));
    const pool = computeArmoryPool(APECHAIN, TOKEN);

    try {
      // The pool was initialised before NFTX registered the collection, so the
      // first log seen is the launch Mint, not Initialize.
      await indexer.process({
        chains: {
          [APECHAIN]: {
            simulate: [
              {
                contract: "NFTXArmory",
                event: "MarketRegistered",
                srcAddress: config.market as Hex,
                block: { number: START, timestamp: 1_000 },
                params: { _collection: COLLECTION, _token: TOKEN },
              },
              {
                contract: "ArmoryV3Pool",
                event: "Mint",
                srcAddress: pool as Hex,
                block: { number: START + 5, timestamp: 2_000 },
                transaction: txOf(1),
                logIndex: 0,
                params: {
                  sender: config.market as Hex,
                  owner: "0x75301ade925a7e7f47cb00de7324ff2efaf5306a",
                  tickLower: -887_200n,
                  tickUpper: 887_200n,
                  amount: 10n ** 18n,
                  amount0: 10n ** 18n,
                  amount1: 10n ** 18n,
                },
              },
            ],
          },
        },
      });
    } finally {
      node.close();
      process.env.ENVIO_APECHAIN_RPC_URL = saved;
    }

    // One read of the pool, at the block before the Mint.
    t.expect(node.calls).toEqual([{ to: pool, block: numberToHex(START + 4) }]);
    const poolRow = await indexer.Pool.getOrThrow(`${APECHAIN}_${armoryPoolId(pool)}`);
    t.expect(poolRow.sqrtPrice).toBe(PREINIT_PRICE);
    t.expect(poolRow.tick).toBe(PREINIT_TICK);
    t.expect(poolRow.createdAtBlockNumber).toBe(BigInt(START + 5));
    t.expect(poolRow.liquidity).toBe(10n ** 18n);
    t.expect(await indexer.ModifyLiquidity.getAll()).toHaveLength(1);
  }, 120_000);
});
