/**
 * The receipt effect's retry and validation policy, exercised directly with a
 * scripted source and an instant sleep. What HyperIndex does with a throw
 * (halt the chain) is covered from the handler side in hookActivity.test.ts.
 */
import { describe, expect, it } from "vitest";
import { loadFixture, POOL_MANAGER, TX } from "../test/helpers/receipts";
import { fetchReceiptSummary, RECEIPT_RETRY, ReceiptMismatchError, trimReceipt } from "./utils/transactionReceipt";

const fixture = loadFixture(TX.canonicalCreation);
const request = { chainId: 1, hash: fixture.transactionHash, blockNumber: fixture.blockNumber, blockHash: fixture.blockHash };
const instant = { attempts: 3, delayMs: 100, sleep: async () => {} };

describe("fetchReceiptSummary", () => {
  it("returns the trimmed receipt on the first good answer", async () => {
    const summary = await fetchReceiptSummary(request, async () => fixture, instant);
    expect(summary.hash).toBe(fixture.transactionHash);
    expect(summary.from).toBe("0xB8A70b4d1547bf6193bd67A73F4F98ea9FD0A973");
    expect(summary.status).toBe("success");
    // 357 is a hook log of an unsubscribed event (PoolFeeSet); it goes.
    expect(summary.logs.map((l) => l.logIndex)).toEqual([355, 356, 363, 364, 373]);
  });

  it("retries with doubling backoff while the node has no receipt", async () => {
    const waits: number[] = [];
    let calls = 0;
    const summary = await fetchReceiptSummary(request, async () => (++calls < 3 ? null : fixture), {
      attempts: 4,
      delayMs: 1000,
      sleep: async (ms) => void waits.push(ms),
    });
    expect(calls).toBe(3);
    expect(waits).toEqual([1000, 2000]);
    expect(summary.blockNumber).toBe(fixture.blockNumber);
  });

  it("gives up after the configured attempts and names the problem", async () => {
    let calls = 0;
    await expect(fetchReceiptSummary(request, async () => (calls++, null), instant)).rejects.toThrow(
      new ReceiptMismatchError(`receipt for ${request.hash} on chain 1 unusable after 3 attempts: the node returned no receipt`),
    );
    expect(calls).toBe(3);
  });

  it("treats a receipt for another block as not-yet-available, then fails", async () => {
    const stale = { ...fixture, blockNumber: fixture.blockNumber - 1, blockHash: `0x${"ee".repeat(32)}` };
    await expect(fetchReceiptSummary(request, async () => stale, instant)).rejects.toThrow(/event was observed in block 25653470/);
  });

  it("accepts the receipt once the node catches up to the event's block", async () => {
    const stale = { ...fixture, blockHash: `0x${"ee".repeat(32)}` };
    let calls = 0;
    const summary = await fetchReceiptSummary(request, async () => (++calls === 1 ? stale : fixture), instant);
    expect(calls).toBe(2);
    expect(summary.blockHash).toBe(fixture.blockHash);
  });

  it("refuses a reverted transaction outright", async () => {
    await expect(fetchReceiptSummary(request, async () => ({ ...fixture, status: "reverted" }), instant)).rejects.toThrow(/is reverted/);
  });

  it("refuses a receipt for a different hash outright", async () => {
    await expect(
      fetchReceiptSummary(request, async () => ({ ...fixture, transactionHash: `0x${"ff".repeat(32)}` }), instant),
    ).rejects.toThrow(/asked for/);
  });

  it("does not retry a source that throws: transport retries belong to the client", async () => {
    let calls = 0;
    await expect(
      fetchReceiptSummary(request, async () => {
        calls++;
        throw new Error("HTTP 503");
      }, instant),
    ).rejects.toThrow("HTTP 503");
    expect(calls).toBe(1);
  });

  it("defaults to five attempts over about fifteen seconds", () => {
    expect(RECEIPT_RETRY.attempts).toBe(5);
    const total = Array.from({ length: RECEIPT_RETRY.attempts - 1 }, (_, i) => RECEIPT_RETRY.delayMs * 2 ** i).reduce((a, b) => a + b, 0);
    expect(total).toBe(15_000);
  });
});

describe("trimReceipt", () => {
  it("keeps PoolManager logs by address and NFTX logs by topic, lowercased and ordered", () => {
    const shuffled = { ...fixture, logs: [...fixture.logs].reverse() };
    const summary = trimReceipt(1, shuffled);
    expect(summary.logs.map((l) => l.logIndex)).toEqual([355, 356, 363, 364, 373]);
    expect(summary.logs.every((l) => l.address === l.address.toLowerCase())).toBe(true);
    expect(summary.logs.filter((l) => l.address === POOL_MANAGER).map((l) => l.logIndex)).toEqual([355, 363]);
    expect(summary.logCount).toBe(fixture.logs.length);
  });

  it("drops everything else", () => {
    const noisy = {
      ...fixture,
      logs: [
        ...fixture.logs,
        { logIndex: 999, address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", topics: [`0x${"dd".repeat(32)}`], data: "0x" },
      ],
    };
    expect(trimReceipt(1, noisy).logs.some((l) => l.logIndex === 999)).toBe(false);
    expect(trimReceipt(1, noisy).logCount).toBe(fixture.logs.length + 1);
  });
});
