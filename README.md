# Robinhood Chain Meme-Coin Trader

An event-driven trading system for new token launches on Robinhood Chain (chain ID 4663). It follows launch events from discovery through token and pool resolution, security and launch-quality checks, quotation, transaction simulation, optional live entry, receipt verification, and position tracking. A separate exit manager can sell tranches when configured price milestones are reached.

**Project status: In development.** The launch-to-entry execution path is implemented and a live curve entry is recorded. The strategy's economic alpha layer—momentum signals, entry timing, expected-value decisions, and replay-based validation—has **not** been implemented. A working trade pipeline is not evidence of a profitable strategy, and this project makes no profitability claim.

## How this differs from my other trading systems

| System | Trigger | Core decision | Transaction |
| --- | --- | --- | --- |
| This trader | A newly launched PONS token or newly created pool | Whether a launch clears route, security and quality gates | Buy the launch token; manage the resulting position |
| DEX arbitrage bot | A price difference between DEX pools | Whether an atomic round trip clears cost and route checks | Flash loan, two swaps and repayment |
| Aave liquidation bot | A borrower's position becomes liquidatable | Whether debt repayment and collateral seizure are viable | Flash loan, liquidation, collateral swap and repayment |

These are three distinct state machines. The meme-coin trader takes directional exposure to a token after launch. Its present filters constrain *which launches may be traded*; they do not establish that buying the selected launches has positive expected value.

## Architecture

1. **Ingest and recover events.** `RobinhoodWebSocketListener.ts` subscribes to configured factory and launch sources. `BlockReconciler.ts`, `BoundedLogScanner.ts`, and `BlockEventStore.ts` support persistence and log backfill. `AnalysisDedupe.ts` claims event identities before analysis so a live event delivered again through backfill does not start another buy decision.
2. **Resolve the venue and phase.** `PonsLaunchAdapter.ts` and `PonsV2Resolver.ts` distinguish a PONS V2 bonding-curve launch from a token that has graduated to a Uniswap V4 pool. PONS V1 launches are routed through the Uniswap V3 `PoolCreated` handler. A `TokenDeployed` notification alone is not treated as a tradable launch.
3. **Apply pretrade gates.** `PonsTokenScreen.ts`, `ContractRiskAnalyzer.ts`, `EarlySupplyConcentration.ts`, and `PonsLaunchGate.ts` check configured token-risk and launch-quality conditions, including the allowed pair token, launch freshness, curve tolls and measurable concentration. The optional `SellPathProbe.ts` is controlled by configuration. The graduated V4 lane has its own liquidity and volume gate. Missing required measurements can reject a candidate; these heuristics cannot certify a token as safe from a rug pull.
4. **Quote and execute.** The curve lane uses `PonsV2CurveAdapter.ts` to read curve state and quote a buy with its fee and tax schedule. The graduated lane uses `PonsV4StateView.ts`, `PonsV4Quoter.ts`, and `PonsV4Router.ts`. Both paths check transaction readiness, set an output minimum, simulate the transaction, reserve a nonce, submit, verify the receipt, and register the acquired token balance. `V3CandidateProcessor.ts` and `V3TradeAdapter.ts` support a separate V3 pool lane.
5. **Track and exit positions.** `LiveExitManager.ts` saves confirmed fills and polls their current venue. Its configurable milestone rule defaults to selling 20% of the *remaining* tokens for each additional 100% rise in the estimated value of the original position. It can use the curve before graduation and V4 afterward.

`ConcurrencyPool.ts` runs independent token analyses with a bounded default concurrency of four. Nonce reservations and position-file writes remain serialized to avoid collisions. Decision traces and rejection statistics are stored for diagnosis.

## What has been demonstrated

The repository records a live curve entry and includes an entry-to-position path. The supplied reports document active launch discovery and gate decisions, and describe subsequent fixes for duplicate analysis and concurrent nonce allocation. The concurrency change compiled and passed 84 reported tests; its expected latency improvement had not yet been measured live at the time of the report.

A completed exit sale, profitable strategy, live graduated V4 entry, and comprehensive event coverage have not been established by the supplied material. This remains an in-development system, with execution validation and economic research still in progress.

## Run and inspect

```bash
npm install
npm run build
npm test
npm run bot:simulate
npm run bot:paper
```

`npm run bot:live` invokes the live listener. Broadcasting additionally requires explicit configuration, including `ALLOW_LIVE_BROADCAST=true`, `EXECUTION_MODE=CANARY` or `LIVE`, signing credentials, and a usable Robinhood Chain RPC. The defaults do not authorize a live broadcast. Configure `EVENT_BUFFER_MS` deliberately: its code fallback is 20 seconds, which is significant for launch timing. Keep signing credentials out of the repository.

## Current boundaries and next research

- **Economic decision layer:** Add measurable momentum, liquidity/flow and entry-price hypotheses, explicit position sizing, and a replay process that compares proposed entries with later outcomes. A security pass is a prerequisite to consideration, not a buy signal.
- **Event coverage:** The reported live run recovered some launches after the freshness window and recorded a log-range failure. Reconciliation, RPC limits and event lag still need live stress testing.
- **Concurrency and transaction recovery:** The bounded analysis pool and shared per-address nonce manager have test coverage, but the post-change latency has not been measured live in the supplied reports. Dropped or replaced transactions need a nonce-reconciliation policy.
- **Exits and manual intervention:** The milestone exit path is implemented, but no confirmed exit appears in the supplied reports. Before relying on it with live capital, reconcile saved positions with actual holdings and manually closed trades so the scheduler does not repeatedly attempt to sell tokens already sold.
- **Security limits:** Supply concentration, contract inspection and the optional sell probe reduce specific risks only when the relevant checks are enabled and measurable. The bot cannot guarantee safety, fill quality or the absence of malicious token behavior.

The project demonstrates a working event-to-trade architecture and the engineering needed to handle launch-state transitions, guarded execution and concurrent event processing. Its remaining research task is to show whether any entry policy has an economic edge after fees, slippage, missed launches and exits.
