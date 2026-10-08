# Supplemental boundary tests

These files add coverage without changing accepted contracts, existing tests,
dependencies, or configuration. They use the vendored dependencies and run offline
with the default Foundry profile.

| File | Additional coverage |
| --- | --- |
| `LaunchTokenAllowance.invariant.t.sol` | Four actors randomly approve, revoke, overwrite approvals, transfer, and spend each other's allowances. An independent ledger checks every balance and all 16 allowance pairs after each action. Invalid recipients, insufficient balances, and insufficient allowances must revert without changing either ledger. Infinite approvals, delegated self-transfers, zero transfers, full balances, and maximum integers are included. |
| `SwarmSellerTokenBoundary.t.sol` | Token pulls mutate balances before returning truncated, false, noncanonical, empty, or up to 64 KiB of return data. Rejected successful returns must restore the entire batch, including earlier swaps and approvals. Reverted pulls must restore their own changes and permit the next row. No-return tokens exercise settlement and refunds, and six-decimal amounts must move without rescaling. Settlement transfers that underpay or overpay must refund their row and roll back their mint/burn effects. |

The new invariant runs 256 sequences of 64 actions, with unexpected handler reverts
treated as failures. Tokens are funded once at setup; random calls cannot mint.
Deterministic tests pin revocation, overwriting, successful delegated transfers,
failed transfers, a full-supply round trip, and recovery after a reverted sale.
Each new stateless fuzz property runs 1,000 cases. Counts are configured inline.

The settlement fixture deliberately violates exact-transfer behavior to check safe
failure. It does not claim support for arbitrary taxed or rebasing tokens. Seller
return-data tests use the existing signed-ledger PoolManager mock; the accepted
suite separately exercises the vendored real Uniswap v4 implementation.

No reproducible implementation defect was found in these cases. Mainnet forks and
the deployed distributor/IMD pools were not exercised; live integration validation
remains outstanding. No scratch files are required by the delivered tests.
