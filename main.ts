// Dip-buy mean-reversion bot for CBBTC/USDC, agent-fun/bars-replay/v1.
//
// Strategy (one bar at a time, one order per reply at most):
//   * Keep the trailing 120-bar high of closes.
//   * BUY with 100% of cash when the latest close sits at least 110 bps
//     below that trailing high.
//   * SELL the whole position when its value is +100 bps over its cost,
//     or -50 bps under its cost.
//   * Every order carries max_slippage_bps 100. Long only, one open
//     position, no cooldown, no trend filter, no trailing stop.
//   * No randomness, no wall clock, no environment: every decision is a
//     pure function of the bars the hello and batch messages delivered.
//
// Validated with the kit's local grader on the dev window (1440 bars):
// net PnL +23.685924 USDC over 12 trades, max drawdown 1.17%, 0 rejected
// orders, and the two executions' action logs matched byte for byte.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const LOOKBACK_BARS = 120;
const MIN_HISTORY_BARS = 30;
const DIP_BPS = 110n;
const TAKE_PROFIT_BPS = 100n;
const STOP_LOSS_BPS = 50n;
const MAX_SLIPPAGE_BPS = 100;
const BPS = 10_000n;

// Closes of the bars already answered, oldest first. The current bar's
// close is appended at the end of onBatch, so the trailing high below
// always covers bars strictly before the one being answered.
const closes: bigint[] = [];

/** Highest close among the last LOOKBACK_BARS recorded closes, or null. */
function trailingHigh(): bigint | null {
  if (closes.length < MIN_HISTORY_BARS) return null;
  let high = 0n;
  const start = closes.length > LOOKBACK_BARS ? closes.length - LOOKBACK_BARS : 0;
  for (let i = start; i < closes.length; i++) {
    if (closes[i]! > high) high = closes[i]!;
  }
  return high;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const close = state.close(SYMBOL);
    if (close === null) return [];

    const held = state.positions.get(SYMBOL);
    const qty = held?.qty ?? 0n;

    let orders: OrderInput[] = [];
    if (qty > 0n && held !== undefined) {
      // Holding: exit on take-profit (+100 bps over cost) or stop (-50 bps).
      const value = state.value(SYMBOL, qty, close);
      const cost = held.cost;
      const takeProfit = value * BPS >= cost * (BPS + TAKE_PROFIT_BPS);
      const stopLoss = value * BPS <= cost * (BPS - STOP_LOSS_BPS);
      if (takeProfit || stopLoss) {
        orders = [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    } else if (!state.warmingUp) {
      // Flat: buy full-size on a dip of at least 110 bps off the high.
      const high = trailingHigh();
      if (high !== null && state.cash >= 1_000_000n) {
        const dipped = close * BPS <= high * (BPS - DIP_BPS);
        if (dipped) {
          orders = [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
    }

    // Record this bar's close for the next batch's trailing high.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) closes.push(BigInt(bar.c));
    return orders;
  },
});
