# Swarm Harvester (HARVEST) — IMD Hackathon entry

**One transaction to claim every identity.md launch reward you've earned, and one more to turn all of them into IMD.**

- Site: https://nuantree.github.io/swarm-harvester-site/ (live data) · IMD-hosted original: https://harvest.sites.imd.fun
- Chain: Ethereum mainnet
- **IMD explorer (prompt, agents, checks, token):** https://explorer.imd.fun/jobs/dc212460-0a28-4e3f-9485-2340b7051f1e
- X: [@HarvestIMD](https://x.com/HarvestIMD) · Dev: [@nuantree](https://x.com/nuantree)
- Prize wallet: 0xb1292411d17f540e7b7bcb9928b4a62fc3d8a22e

## The problem

Every IMD launch sends 10% of its supply to swarm wallets through its own Merkle distributor: 2% to the wallets that did the work, 8% split across seats connected at admission. With 300+ launches so far, an active seat wallet collects dozens of separate allocations. Each one needs its own claim transaction and its own sale. On 2026-10-08 we sampled seat wallets and found 16–70 unclaimed launches per wallet; one wallet had 61. Most of these rewards are never claimed, so seat holders don't feel the work they did.

## What Swarm Harvester does

| Contract | Address | What it does |
|---|---|---|
| SwarmHarvester | [0x390f407adad27a0f267479a8449d6a5c6daa93cf](https://etherscan.io/address/0x390f407adad27a0f267479a8449d6a5c6daa93cf) | `claimMany(Claim[])` submits any number of distributor claims in one transaction. Permissionless: anyone can harvest for anyone, and tokens always go to the wallet that earned them. Claims that are already used or invalid are skipped, never reverting the batch. The contract never holds tokens. |
| SwarmSeller | [0xc20dbee43247461b57cbc781356ae2bd9de67db6](https://etherscan.io/address/0xc20dbee43247461b57cbc781356ae2bd9de67db6) | `sellMany(Sale[], recipient, minImdOut, deadline)` sells many launch tokens into **IMD** through Uniswap v4 (token/IMD, or token/ETH → ETH/IMD), with per-sale and total minimums. A failed sale refunds that token. **0.5% of the IMD output is burned** to `0x…dEaD`. |
| HARVEST token | [0x1553a3d4ae3efa98fb9a0e261602bc4d4d580452](https://etherscan.io/address/0x1553a3d4ae3efa98fb9a0e261602bc4d4d580452) | The project's launch token, created by the IMD launch factory. |

No owner, no admin keys, not upgradeable, not pausable. Constructor arguments are immutable: Uniswap v4 PoolManager `0x000000000004444c5dc75cB358380D2e3dE08A90` and IMD `0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7`.

## How it uses IMD

1. **Built on IMD's own reward system.** It reads the IMD explorer's reward APIs (`/api/earned`, `/api/claim`) and calls the launch factory's MerkleDistributor contracts. On chain, the site resolves the right round by matching the proof root against `roundOf`, and simulates every claim before it is offered.
2. **Every sale buys IMD.** All harvested launch tokens are routed into IMD, so seat rewards become IMD demand instead of dust.
3. **Burns IMD.** Every sale burns 0.5% of its IMD output.
4. **Built, audited, deployed and hosted entirely by the IMD swarm.** It was ordered through `workflow.open` and paid in IMD.

## Built by the swarm (provenance)

| Stage | Record |
|---|---|
| Contracts, tests, 4 specialist audits + judge | job [46726879](https://explorer.imd.fun/jobs/46726879-5de6-4379-8e15-4b219a662c16) · repo [launch-1029](https://github.com/identity-md-launches/launch-1029-workflow-contract-stage-context) |
| Mainnet launch | launch `e3c2f693-9f28-46d0-af84-865a8e9f995a` (all admission checks passed; bytecode reproducible) |
| Website | [swarm-harvester-site](https://github.com/Nuantree/swarm-harvester-site): the swarm's frontend plus the snapshot fallback, on GitHub Pages · original repo [launch-1034](https://github.com/identity-md-launches/launch-1034-workflow-frontend-stage-context) · hosted at harvest.sites.imd.fun (CID `bafybeihkirvkxhifsefbcu6g7mbgncsqup7pu5wss4pk3f7lv3oyw3iadm`) |
| Earlier attempt | workflow `aa355f13` / repo [launch-1018](https://github.com/identity-md-launches/launch-1018-workflow-contract-stage-context). The contracts and audits passed, but the launch was parked over a pool-pair wording conflict. The final launch reuses that code unchanged. |

**What was checked:** the audit judge's final findings were one low-severity item (address letter-case in launch.json; it is the same address) and one info item (an unused error declaration). Invariant tests: the harvester never holds tokens, the seller keeps no user tokens or IMD after a call, and exactly 0.5% of the output is burned. We also confirmed on chain that the deployed seller's `imd()`, `poolManager()` and `FEE_BPS()` match the source, and that the token reads `Swarm Harvester` / `HARVEST`.

## Demo evidence

- Demo claim transaction: [0x2e7e79ed757767e3e9d4ab3ed116912912954523b3d13dffdb80d64ba071526a](https://etherscan.io/tx/0x2e7e79ed757767e3e9d4ab3ed116912912954523b3d13dffdb80d64ba071526a). The keeper wallet 0xb129…a22e harvested **40 launch rewards** for seat wallet 0x120e…19c5 in one call (40 `ClaimResult` ok, 0 skipped; 4.06M gas, about 0.0007 ETH). All 40 transfers went to 0x120e…19c5, and the harvester held nothing.

## Known limitation and risks

- **Reward APIs aren't readable from browsers, so we added a snapshot.** `explorer.imd.fun/api/earned` and `/api/claim` send no CORS headers. We added a free, automatic fix: [swarm-harvester-data](https://github.com/Nuantree/swarm-harvester-data) republishes the same public reward data every hour through GitHub Actions. The site tries the IMD APIs first and falls back to the snapshot ([source change](https://github.com/Nuantree/swarm-harvester-site)). Merkle trees are frozen once a launch is live, so the snapshot can't go stale; at most, a launch appears up to an hour late. Every claim is still checked on chain and simulated before it is offered. The IMD-hosted copy at harvest.sites.imd.fun has no fallback and works only through the site's manual import panel.
- **Agent audits are not a professional audit.**
- **SwarmSeller relies on the caller for safety.** It trusts the caller to pass sensible pool keys and minimum outputs. The site quotes these, and anyone calling the contract directly must set their own minimums.
- **Unsupported tokens.** Fee-on-transfer and rebasing tokens aren't supported. A sale of one of them refunds or reverts.
- **The ENS URL doesn't load.** The ENS gateway URL (harvest.site.identitymd.eth.limo) fails TLS, as all multi-level eth.limo IMD sites currently do. Use harvest.sites.imd.fun.

## Code reuse

All code was written by the IMD swarm for this entry during the hackathon window (Oct 8, 2026). It depends on OpenZeppelin and Uniswap v4-core. The final launch reuses the swarm's own first attempt (launch-1018) unchanged.
