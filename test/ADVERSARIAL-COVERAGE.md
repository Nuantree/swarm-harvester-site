# Additional adversarial coverage

The tests extend the accepted implementation without changing contracts or dependencies.
They run with the default `forge test` discovery and need no network, environment
configuration, FFI, or files from `test/scratch`.

| File | Properties exercised |
| --- | --- |
| `SwarmHarvesterAdversarial.t.sol` | Nonempty Merkle proofs bind the wallet and amount; proofs cannot be relabelled to an unpublished round; round zero and the maximum round remain independent across wallets and distributors; underfunded and rejected payouts remain retryable; each row emits its own ordered result; a 64-row batch skips duplicates, including a zero-amount claim. |
| `SwarmSellerAdversarial.t.sol` | Mixed-token batches refund unsuccessful rows, preserve later successes, and round the fee once; actual payouts and events agree; arithmetic reaches the signed swap-delta boundary; invalid inputs do not consume approvals; later malformed token returns, failed refunds, or unmet aggregate minima roll back earlier swaps and allowances; gas-exhausting and large-revert token pulls do not stop later sales; deadline equality is accepted. |
| `SwarmLifecycle.invariant.t.sol` | Four wallets change approvals, transfer HARVEST, submit claims with two-level proofs, replay or corrupt claims, and sell through real local Uniswap v4 pools. Random batches alternate direct and native intermediate routes, missing pools, impossible sale minima, and aggregate reverts. |

The lifecycle invariant runs **256 sequences of 64 calls**. Its independent ledgers
track each wallet's input balance, approval, received IMD, and claim status. It checks:

- HARVEST remains at exactly `10^27` units, with all balances accounted for.
- Claims pay only their named wallets, at most once per wallet and round.
- Successful sales debit only the caller; refunded sales return their input.
- Finite approvals reflect successful pulls, including pulls subsequently refunded;
  reverted batches restore approvals and balances.
- IMD leaving the PoolManager equals recipient proceeds plus the per-batch rounded
  50-basis-point fee paid to the fixed sink.
- Supported flows leave neither application holding input tokens, IMD, or native ETH.
- Native intermediate credit nets inside the manager. Seller currency deltas and
  the manager's unlock/count state are checked before the handler call ends, while
  transient storage is still observable.

The handler funds all wallets and pools once during setup. Random actions cannot
mint more tokens. Its swap oracle predicts input and allowance effects before the
call; gross output is measured at the actual vendored PoolManager, independent of
the seller's return value. A deterministic handler test ensures that successful
claims, replays, refunded rows, revoked approvals, and aggregate rollback execute.
Each new stateless fuzz property has **1,000 runs**, set inline in its source.

These properties cover exact-transfer tokens and the routes in the approved
workflow. They do not assert that unsolicited donations can be prevented or that
an arbitrary malicious distributor necessarily pays when its call returns success.
The local distributor checks selector/argument forwarding and batch behavior; it
does not establish the deployed distributor's leaf format or current roots.

No reproducible contract defect was found by this extension. Mainnet distributor
replay and swaps against deployed IMD pools/hooks were not run in this assignment;
live integration verification remains separate from this offline suite.
