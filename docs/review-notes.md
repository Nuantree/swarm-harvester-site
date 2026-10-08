# Implementation check evidence

This is the implementer's report, not the stage's independent source/manifest review.

## Relaunch scope and provenance

This contribution restores [release `6e3d9177c615c7dc9854b32076d9d48405be60a8`](https://github.com/identity-md-launches/launch-1018-workflow-contract-stage-context/tree/6e3d9177c615c7dc9854b32076d9d48405be60a8). All 110 original source, test, optional integration, dependency and Foundry configuration files were compared byte-for-byte against the pinned archive and remain unchanged. The three inherited ABI arrays match the current Solidity compiler output.

The approved relaunch decision is **HARVEST paired with native ETH**. SwarmSeller still sells claimed launch tokens into IMD through the unchanged direct or native-intermediate routes. Its constructor remains `(poolManager_, imd_)`, using `0x000000000004444c5dc75cB358380D2e3dE08A90` and `0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7`, respectively. No owner or new deployment setting was introduced.

README and ABI documentation now reflect that decision. The old manifest's pairing-conflict note is historical and has been superseded by the approved workflow; the separate manifest contributor should describe the native-ETH decision without carrying that conflict forward. This source contribution does not generate `launch.json`.

The inherited dependency metadata contained 17 file hashes that did not match its own vendored files. `docs/dependencies.json` now records the actual delivered hashes, preserves those prior recorded hashes separately, and identifies the pinned source release. All 91 dependency-file hashes now match. Dependency code and licenses were not changed, and no dependency fetch is needed to build.

## Preserved security behavior

The restored implementation's only allowance pull encodes `transferFrom(msg.sender, address(this), amount)` in the batch entrypoint's internal helper. The self-only swap helper has no payer parameter and cannot spend allowances. Tests demonstrate that another wallet cannot consume a victim's approval, and that direct helper and idle/forged/repeated callback calls fail.

The seller uses the PoolManager's signed swap deltas and verified settlement payment to account for each sale. Every hop must spend exactly its specified input; native intermediate credit cancels inside the manager. The batch is guarded across all external interactions. Tests attempt reentry during input pull, settlement, swap hooks, IMD take, fee transfer and payout.

Batch totals and claim flags are explicitly initialized. External calls in loops are intentional for batching; claim, pull and swap calls have fixed gas budgets, and refunds use atomic transaction rollback if they cannot complete. Timestamp comparison enforces the caller's deadline; it is not a randomness source.

## Checks performed for this contribution

- `forge build`: passed with compiler 0.8.26, metadata hash disabled, Foundry 1.8.5.
- `forge test`: **56 passed, 0 failed, 0 skipped**, across eight suites, including real local v4 core integration. Base fuzz properties ran 256 cases each; the three additional adversarial fuzz properties ran 1,000 each. The conservation invariant executed 4,096 calls and the lifecycle invariant executed 16,384 calls, both with zero handler reverts.
- A clean temporary copy containing only source, vendored libraries, submitted tests and configuration passed `forge build --offline` and `forge test --offline --threads 4` with an empty process environment. The same 56 tests passed. No scratch files, previous build artifacts, network installation, or repository input files were included in that copy.
- `forge fmt --check`.
- `forge lint --severity high -- src/LaunchToken.sol src/SwarmHarvester.sol src/SwarmSeller.sol`: no high-severity diagnostics.
- Runtime scan stepping over PUSH operands: no DELEGATECALL, CALLCODE or SELFDESTRUCT in any application/token bytecode; all three below 24,576 bytes. At this build: LaunchToken 1,722 bytes, SwarmHarvester 963 bytes, SwarmSeller 5,955 bytes.
- A separate local scratch test deployed all three contracts through a CREATE2 factory probe using the approved mainnet seller arguments, confirmed the full `1e27` supply remained with the factory, checked the immutable dependencies, and scanned the deployed runtimes for size and forbidden instructions. It passed and is not part of the submitted 56-test suite or a substitute for the protected harness.
- All ABI arrays and the pinned file/dependency checks described above passed.

Foundry's broader lint still emits generic warnings about batching external calls, deadline timestamps, checked signed conversions, temporary callback authorization state and guard/event ordering around external calls. The explicit call graph and adversarial tests above address the intended behavior; no detector suppression was added. An additional read-only review found no concrete defect in the supported exact-transfer flows. This does not replace the stage's separate independent source/manifest review. Slither, Mythril and a formal security audit were not run in this assignment.

## Historical live integration evidence

The pinned release reported a successful real-mainnet distributor fork replay at block 26,145,141 through `https://rpc.mevblocker.io`. That optional replay, current APIs, mainnet dependency bytecode and deployed pool/hook behavior were not rechecked during this relaunch contribution. Those historical observations do not establish current production state. The offline suite exercises the vendored local PoolManager and mock tokens/distributors; deployment services and frontend operators must verify the actual dependencies and handoff before use.

The fork proof was copied from successful mainnet transaction `0x088f898e9e2789544793bec9e4e69da3ec58b88d004bed1c39664e2f4796ea96` at block 26,145,142, with account `0xc60c81b48bdf107e1651e8ebee971e84885febda`. It is a historical public allocation, not a production configuration value or a stand-in wallet. It is embedded in Solidity so the default tests need neither a proof API nor filesystem reads.

## Independent review and service handoff

Review should verify the exact mainnet seller constructor addresses, absence of wallet spending paths other than the caller pull, callback lifecycle, atomic refunds, gross-versus-net minima, integer fee rounding, full-fill requirement, hook assumptions, unsupported token behavior and inability to recover donations. The raw pull call copies at most one return word; a revert is safely skipped, while a successful false/malformed return aborts the batch because it may already have moved tokens.

Use the canonical service linkage model for policy and signed artifacts. Publishing, attestation, admission, deployment, source verification and frontend hosting are later service operations. This contribution supplies no `launch.json`, policy signature, deployment transaction or frontend deployment address.

Primary protocol references: [Uniswap v4.0.0 IPoolManager](https://github.com/Uniswap/v4-core/blob/v4.0.0/src/interfaces/IPoolManager.sol), [v4.0.0 PoolManager](https://github.com/Uniswap/v4-core/blob/v4.0.0/src/PoolManager.sol), and the licenses preserved with each vendored dependency.
