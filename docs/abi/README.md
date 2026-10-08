# ABI handoff

The adjacent `LaunchToken.json`, `SwarmHarvester.json` and `SwarmSeller.json` are plain compiler-generated ABI arrays, suitable for ethers or viem. They include tuple components, errors and events. They contain no deployment addresses; obtain those from the deployment handoff.

The HARVEST launch pool pairs with native ETH. SwarmSeller independently sells callers' claimed launch tokens into IMD; its `poolManager_` and `imd_` constructor arguments and sale routes remain unchanged from the [pinned prior release](https://github.com/identity-md-launches/launch-1018-workflow-contract-stage-context/tree/6e3d9177c615c7dc9854b32076d9d48405be60a8). See the root README for the exact constructor addresses. The separate manifest contribution records the launch pairing and deployment parameters.

Regenerate after source changes with Solidity 0.8.26:

```sh
forge build
forge inspect LaunchToken abi --json > docs/abi/LaunchToken.json
forge inspect SwarmHarvester abi --json > docs/abi/SwarmHarvester.json
forge inspect SwarmSeller abi --json > docs/abi/SwarmSeller.json
```

`Sale.minOut` is gross IMD. `sellMany.minImdOut` and its return value are net IMD after the single aggregate fee. All amounts use the corresponding token's minor units. `deadline` is a Unix timestamp in seconds. `executeSale` and `unlockCallback` are protocol plumbing and must not be exposed as wallet actions. The only user write actions are token `approve`/ERC20 transfers, harvester `claimMany`, and seller `sellMany`.
