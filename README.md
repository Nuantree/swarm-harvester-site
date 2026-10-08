# Swarm Harvester (HARVEST)

Ethereum mainnet contracts for claiming identity.md launch allocations and selling the caller's tokens into IMD. This contribution delivers source, tests, vendored dependencies and ABI exports. The separate manifest contributor supplies `launch.json`; the launch services publish, attest, admit and deploy, then provide deployment addresses to the frontend contributor.

This second launch attempt reuses the contracts and tests from the [pinned prior release, commit `6e3d9177c615c7dc9854b32076d9d48405be60a8`](https://github.com/identity-md-launches/launch-1018-workflow-contract-stage-context/tree/6e3d9177c615c7dc9854b32076d9d48405be60a8). The application logic, constructor arguments and tests are preserved. The corrected launch decision is that **the HARVEST launch pool pairs with native ETH**. SwarmSeller remains separate from that launch pool and sells callers' claimed launch tokens into IMD.

## Build and test

```sh
forge build
forge test
forge fmt --check
```

Solidity is pinned to **0.8.26**, with Cancun, optimizer runs 200 and `bytecode_hash = "none"`. No FFI or filesystem cheatcode permissions are enabled. Dependencies are ordinary source files in `lib/`; builds and default tests need no network or environment configuration once Foundry and the pinned compiler are installed. Dependency versions, licenses and checksums are in [docs/dependencies.json](docs/dependencies.json).

The default suite covers ERC20 supply/allowances, permissionless claims, wrong proofs/rounds, duplicates, gas grief, direct/native routes, caller authorization, callback authentication, refunds, partial fills, slippage, settlement and payout failures, reentrancy, and fee rounding. It includes the actual vendored Uniswap v4 PoolManager, a stateful conservation invariant configured for 128 runs × 32 calls, and a lifecycle invariant configured inline for 256 runs × 64 calls. Base fuzz tests use 256 runs; the added adversarial fuzz properties use 1,000 runs each. Mock pools are only used to control adverse behavior, not to establish compatibility by themselves.

The optional archive-RPC test is isolated from default discovery:

```sh
FOUNDRY_PROFILE=fork forge test --match-contract DistributorForkTest -vv
```

It contains a public RPC URL and a genuine historical proof as constants; it never reads or sets environment variables. The profile is selected by the command. It replays [transaction 0x088f…ea96](https://etherscan.io/tx/0x088f898e9e2789544793bec9e4e69da3ec58b88d004bed1c39664e2f4796ea96) against mainnet state at block **26,145,141**, one block before the original claim. The pinned prior release recorded a passing result: round `0` was accepted, round `1` and a different beneficiary were rejected, the named account received the full allocation through the harvester, and the duplicate was skipped. This is prior-release evidence; the optional fork check was not rerun for this contribution. Archive availability is an external prerequisite only for this optional check.

## Contracts and deployment parameters

| Identifier / source | Nonpayable constructor arguments | Purpose |
| --- | --- | --- |
| `LaunchToken` / `src/LaunchToken.sol` | none | Swarm Harvester, HARVEST, 18 decimals; exactly 1,000,000,000 tokens (`10^27` units) minted to the deployer |
| `SwarmHarvester` / `src/SwarmHarvester.sol` | none | Permissionless claim batching |
| `SwarmSeller` / `src/SwarmSeller.sol` | `address poolManager_`, `address imd_`, in that order | Immutable swap dependencies from the table below |

Neither application depends on HARVEST or the other application. There is no owner, initializer, proxy, pause, upgrade, mint-after-construction, fee setter or rescue function. Factory deployment does not grant the factory any application privilege. The launch token has plain ERC20 transfers; the seller's fee is not a token transfer tax.

Required Ethereum mainnet (`chainId = 1`) values:

| Use | Address |
| --- | --- |
| `SwarmSeller.poolManager_` — Uniswap v4 PoolManager | `0x000000000004444c5dc75cB358380D2e3dE08A90` |
| `SwarmSeller.imd_` — IMD, the seller's output currency | `0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7` |
| Fixed seller fee sink, expressly selected in the workflow | `0x000000000000000000000000000000000000dEaD` |
| Launch #953 distributor, used only as verification evidence | `0xdc542889a9799a8b52d5b41285444dd12c4f916f` |
| That distributor's observed `token()` | `0x450e5910DEcEe15c3AC056E3ed66Cb5ea3Dd33BE` |
| That distributor's observed `treasury()` | `0x047F606fD5b2BaA5f5C6c4aB8958E45CB6B054B7` |

Native ETH is represented by `address(0)` only inside Uniswap pool keys. It is not a missing constructor value. No new deployment addresses are invented here; the application and HARVEST addresses must come from the deployment handoff.

For the later manifest: name `LaunchToken` as the launch token and list the two applications above, with the seller arguments exactly as listed. The HARVEST launch pool pairs with native ETH, represented by the zero-address currency in its pool key. Canonical launch pool fields are fee `3000`, tick spacing `60`, initialPrice `"79228162514264337593543950336"`. These admission fields do not assert a 0.3% live trading fee: the services derive the opening price from policy and the factory uses the network's LaunchFees setting for the pool. The factory supplies the distributor and initialization guard and allocates the token supply. The application contracts do not implement or receive those allocations. Policy/signature linkage belongs to the services; source and constructor authorization remain independent review responsibilities.

## Claim behavior and frontend integration

`claimMany(Claim[])` takes `(distributor, round, account, amount, proof)` for each row and returns the number of successful distributor calls. It forwards `claim(uint256,address,uint256,bytes32[])` (`0x2e7ba6ef`) without changing the account. Anyone can submit; no approval or signature from the beneficiary is required. `claimed(uint256,address)` is `0x120aa877`.

Each claim uses `try/catch` with 200,000 gas. Reverts, duplicate claims, invalid proofs, unready rounds and gas-exhausting distributors are reported as `ClaimResult(distributor, account, false)` and skipped. EOAs and zero/self beneficiaries are also skipped. An empty batch succeeds. The caller must provide enough total gas for the batch; transaction-wide out-of-gas or malformed transaction encoding can still revert it. Claim success means the distributor call completed, so use only authenticated distributors and confirm balances/claimed status rather than treating an arbitrary contract's successful return as evidence of a payout.

The API response shapes and deployed-distributor observations below are evidence recorded by the pinned prior release, not checks rerun for this contribution. The frontend operator must confirm them against the deployment handoff and current services.

The frontend should:

1. Connect a wallet or accept a pasted beneficiary, and require Ethereum mainnet for this deployment. Call `https://explorer.imd.fun/api/earned?wallet=ADDR`. The observed response is `{ "claimable": [launchId, ...], "unlocks": [{ "id": launchId, "at": timestamp }, ...] }`. IDs are UUIDs; a displayed launch number such as `953` is not the API ID. Future unlocks are not yet claimable.
2. For each ID fetch `https://explorer.imd.fun/api/claim?launch=ID&wallet=ADDR`. The observed nonempty response is `{ "claim": { "root": "0x…", "amount": "decimal integer", "proof": ["0x…", ...] } }`. Handle missing claims and HTTP failures individually. Parse amounts as arbitrary-precision integers, never JavaScript `Number`.
3. Resolve that launch's authenticated deployment artifacts. The public launch record is available at `https://api.imd.fun/launches/ID`; validate `chainId`, lifecycle status and the artifact with `role: "distributor"`. The earned list can contain launches from other chains, so filter them. Validate deployed bytecode and the distributor's `token()` against the launch's token artifact.
4. Resolve the **round**, not a leaf index. Proof responses observed for the pinned prior release omit both distributor and round. Match `claim.root` to the actual distributor's published round metadata. The previously tested distributor exposes `roundCount()` and `roundOf(uint256)`, whose first ABI return word is the root; both were checked against the deployed contract for that release. Iterate valid round IDs and match the root, or use an authenticated deployment/indexer mapping that supplies the same information. Decode any additional round timing fields using that distributor's verified ABI. Do not globally assume round `0`: that value was verified only for the recorded allocation. If metadata is unavailable or ambiguous, withhold that row rather than guess.
5. Check `claimed(round, beneficiary)` and simulate the call. Construct `Claim[]` from the resolved distributor/round plus the beneficiary, amount and proof. Submit one `claimMany` transaction from the connected keeper wallet. Read results from the harvester address's logs and refresh balances/claimed status. Split very large batches when gas estimation requires it.

The harvester never pulls or forwards assets, and valid distributors pay beneficiaries directly. No contract can prevent someone from transferring arbitrary ERC20 tokens to its address; unsolicited transfers cannot be recovered. The no-custody invariant covers assets handled through the supported flows, not arbitrary donations or malicious distributors that disregard their ABI semantics.

## Sale behavior and frontend integration

`sellMany(Sale[] sales, address recipient, uint256 minImdOut, uint256 deadline)` returns the net IMD paid. Each `Sale` is `(address token, uint256 amountIn, uint256 minOut, PoolKey[] route)`. Each pool key is `(currency0, currency1, uint24 fee, int24 tickSpacing, address hooks)`, with currencies strictly sorted by address. Hooks are included verbatim; hook data is empty. Only these routes are accepted:

- one pool: token → IMD;
- two pools: token → native ETH, then native ETH → IMD.

Inputs must be deployed ERC20 tokens distinct from IMD, with nonzero amounts no greater than `type(int128).max`. Native input, cyclic/disconnected routes, zero tick spacing, unsorted keys and other intermediate currencies are rejected per row before any pull. Pool existence and pool-specific parameters are enforced by the PoolManager. Both hops require full exact-input consumption and positive output; partial fills are refunded as failures. Native credit from hop one is netted against hop two within the PoolManager; the seller does not receive ETH.

The frontend reads the user's token balances, obtains the **exact deployed pool keys** (including hooks and actual fees) and quotes those routes against current mainnet state. Never substitute the launch manifest's admission fee for the actual pool key. Set a short inclusive deadline and explicit minima. `Sale.minOut` is **gross IMD before the batch seller fee**. `minImdOut` is the **aggregate net IMD after the seller fee**; if it is not met, the entire batch reverts, including prior successful swaps and fees. Setting it to zero permits partial success but provides no aggregate protection; the UI should explain that tradeoff and quote only routes it can verify.

Only the wallet calling `sellMany` pays. Approve the deployed seller for the selected amount of each input token, totaling duplicate rows, then call it from that same wallet. There is no arbitrary payer parameter, relayer allowance spending or permit flow. Do not approve the harvester. The seller grants no allowances to any router, hook or PoolManager. Its self-only `executeSale` entrypoint cannot pull any wallet's funds; it is solely a rollback boundary around already-pulled input.

For each row, a reverted input pull is skipped. A successful pull is followed by an isolated swap with a 2,000,000 gas limit. A failed swap, expired/uninitialized pool, slippage failure or settlement failure rolls back that swap and refunds the input to the caller. `SaleResult(index, token, ok, grossImdOut)` identifies each row, including duplicates. A failed refund, failed final IMD transfer, or successful token call returning false/malformed data reverts the **whole transaction**, restoring original balances and approvals. This avoids leaving funds stranded after a token reports contradictory behavior. Optional-empty-return ERC20s are supported; input transfer calls are capped at 200,000 gas.

For gross aggregate output `G`, the fixed fee is `floor(G / 200)` minor IMD units, equivalent to 50 basis points. It is rounded **once per batch**, so sub-200-unit output has zero fee. The recipient receives `G - fee`; the same call transfers the fee to the fixed dead address. For example, gross `20,001` yields fee `100` and net `19,901`. Sending to the dead address removes spendable circulation but does not call IMD's burn function or reduce its ERC20 `totalSupply`. Recipient cannot be zero, the seller itself or the fee sink. `BatchSold` reports caller, recipient, net output and burned amount.

## Trust model

- Supported inputs and IMD must use exact transfers and stable balances. Fee-on-transfer, rebasing and dishonest tokens are unsupported and can revert a batch. Test coverage includes rejecting a taxed input without stranding funds. Token contracts control whether they permit transfers; there is no owner override.
- The immutable PoolManager and IMD addresses must be checked by the manifest reviewer. Swaps trust the genuine PoolManager's signed deltas and settlement accounting, not token balance snapshots. Each callback is restricted to that manager, bound to the pending sale's encoded hash, and consumed before external calls. A reentrancy guard protects the entire batch, including pulls, refunds, fee transfer and recipient payout.
- Users choose pools and thereby trust the selected hooks, liquidity and quote. Full-input checks and minima bound acceptable behavior, but do not make a hostile pool profitable. Quotes are not price oracles; public swaps can be reordered or sandwiched within the user's slippage tolerance.
- The supported flow leaves no input, intermediate ETH or IMD in the seller after completion. Pre-existing donations are neither swept nor counted toward output and are unrecoverable. There is no shared user deposit accounting or administrative withdrawal.
- Gas grief, unavailable liquidity and unsupported hooks can cause individual failures; insufficient transaction gas and nonfunctional refund/output tokens can revert a batch. Frontends should simulate, estimate, and offer smaller batches.

## After launch

There are **no owner-settable dependencies or post-deployment initialization calls**: every outside value needed by these contracts was supplied in the approved workflow. The services must verify the three deployed bytecodes and constructor inputs, publish source and ABIs, and provide the actual deployment addresses and pool keys. The frontend operator must read those values from the handoff, monitor explorer/RPC availability, validate per-launch claims, quote routes, surface skipped/refunded rows and refresh on-chain balances after receipts. The requester does not operate a fee wallet or hold application admin keys.

This implementation's checks are not an independent security audit. The separate contributor review must inspect accepted source and the eventual manifest, including actual dependencies and constructor values, before services deploy. No transaction was broadcast and no funded key was used in this assignment. See [docs/review-notes.md](docs/review-notes.md) for check evidence and limits.
