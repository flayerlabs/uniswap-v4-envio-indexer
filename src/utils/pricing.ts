/*
 * Exchange-ratio math. This is all that is left of the upstream pricing graph:
 * derivedETH / USD valuation needed a chain-wide view of pools that the
 * indexer no longer has, and NFTX's consumers price the raw token amounts
 * themselves. Every USD/ETH-denominated field is written as 0.
 */
import { BigDecimal, type Token } from "envio";

import { exponentToBigDecimal, safeDiv } from "../utils/index";
import { ADDRESS_ZERO } from "./constants";
import { NativeTokenDetails } from "./nativeTokenDetails";

const Q192 = BigInt(2) ** BigInt(192);

/** [token0 per token1, token1 per token0] at a sqrt price, decimal-adjusted. */
export function sqrtPriceX96ToTokenPrices(
  sqrtPriceX96: bigint,
  token0: Token,
  token1: Token,
  nativeTokenDetails: NativeTokenDetails
): [BigDecimal, BigDecimal] {
  const token0Decimals =
    token0.id == ADDRESS_ZERO ? nativeTokenDetails.decimals : token0.decimals;
  const token1Decimals =
    token1.id == ADDRESS_ZERO ? nativeTokenDetails.decimals : token1.decimals;

  const num = new BigDecimal((sqrtPriceX96 * sqrtPriceX96).toString());
  const denom = new BigDecimal(Q192.toString());
  const price1 = num
    .div(denom)
    .times(exponentToBigDecimal(token0Decimals))
    .div(exponentToBigDecimal(token1Decimals));

  const price0 = safeDiv(new BigDecimal("1"), price1);
  return [price0, price1];
}
