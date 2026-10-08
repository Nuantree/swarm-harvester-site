# Swarm Harvester frontend

A one-page Vite / React / TypeScript frontend for the deployed Ethereum contracts. Production files are delivered in `../dist/`; hosting only needs those files. There is no application server, service worker, API key or build step at publication time. No contracts are redeployed.

## Install, build and preview

Use Node 22.12+ (worker: Node 24.9.0) and npm. From this directory:

```sh
npm ci
npm run build
npm run preview
```

Open the preview URL printed by Vite. For development, run `npm run dev` **after the initial build**. Its middleware serves the same generated deployment manifest and ABI files from `../dist/`; React source uses Vite's normal development pipeline. Rebuild after changing the deployment template. All dependencies and build configuration live under `web/`. `web/.gitignore` is explicitly in the assignment's path budget; it excludes dependency/cache/report folders at every nesting level.

`npm run build` typechecks, exports with Vite's relative `./` base, retrieves each ABI from the exact deployed Git commit, compares its bytes with `docs/abi/<Contract>.json`, verifies its canonical Keccak hash, copies it to `dist/abi/`, and then generates and verifies `dist/imd-deployment.json`. A Git checkout containing the deployed commit is required to rebuild. Production browsing requires no Git or Node installation.

## Deployment configuration

`web/deployment.json` is the build input copied from the handoff. It contains all deployment addresses, network settings, the exact pool key, identifiers and ABI bindings. It is **not imported by the React app**. At runtime `src/config.ts` fetches only `./imd-deployment.json` and its referenced ABI JSON, verifies canonical hashes, then creates the public client from that manifest. The build script adds the final asset inventory. Never hand-edit the exported manifest, ABI copies or assets; rebuild them together.

The handoff source is `388f84e9ee292e9a411c0d80c14e8f5f506640eb`. All three implementation ABIs matched the attested hashes. The HARVEST pool key comes from the handoff, including fee **12500**, tick spacing **60**, and the initialization guard hook. The launch manifest's admission fee **3000** is not substituted for the actual pool fee. HARVEST pairs with native ETH. SwarmSeller separately converts launch tokens into IMD.

`src/config.ts` also centralizes external service origins and minimal standard ERC20, distributor and Uniswap interface ABIs. Third-party launch addresses are fetched from public deployment records, token identities are cross-checked on chain, and pool parameters are decoded from the configured PoolManager's `Initialize` logs. No application deployment address, RPC endpoint, router, Permit2 or quoter is duplicated in UI components. Native currency is represented by viem's protocol `zeroAddress`; it is not a missing setting.

## Features and safeguards

- EIP-6963 discovery plus an injected EIP-1193 browser wallet; explicit connection, account display/copy/explorer links, disconnect and chain changes. A 4902/unknown-chain switch failure requests the unchanged handoff `walletAddChain`, then switches again. WalletConnect is not configured because no public project ID was supplied.
- Address or `.eth` lookup without connecting. Claimed launch IDs are remembered locally per viewed address, so their balances remain available after an earned-list refresh. Add an older launch UUID to inspect previously claimed tokens. Local storage is optional; proofs and keys are never persisted.
- Earned responses, per-launch deployment records and claim proofs are fetched from the approved services. Future unlocks are shown separately. Records must be live and on the configured chain. Token/distributor code, the distributor's token, round root, claimed status and an individual claim simulation are checked before a claim becomes selectable. Amounts remain `bigint` throughout. Each root must match exactly one on-chain round; round zero is never assumed.
- Up to 24 launch records are checked per page, four at a time. “Check next” handles the remaining IDs. Round scanning is bounded at 128 rounds; larger/ambiguous distributors are withheld with an explanation. “Claim all” batches the loaded, selected eligible rows. The wallet pays gas; the displayed beneficiary receives the tokens even when it is a different address. Receipt events and fresh balances/claimed flags report skipped claims.
- “Quote token balances” obtains actual pool keys from deployment receipts and quotes each hop with the configured quoter via `eth_call`. Direct token/IMD and token/ETH/IMD routes are supported. ETH/IMD discovery scans backwards in windows of up to 10,000 blocks (splitting refused ranges), at most 1,000,000 blocks, and skips windows whose pools cannot quote the first input. It compares successful quotes in the first usable window; this is not a global best-route search. An exact imported bridge pool key can cover older pools, and is checked on chain. Unquotable tokens are explicitly excluded.
- Seller approvals grant exactly the displayed input amount to **SwarmSeller**, not Permit2. Each token is approved separately and confirmed before proceeding. A reset-to-zero control is available for tokens needing it. Gross per-token minimums and an aggregate **net** minimum use integer arithmetic; the seller's 0.5% burn-sink transfer is rounded once on the aggregate. The aggregate minimum is never zero. The recipient is the connected caller, not an arbitrary configured wallet.
- HARVEST buy/sell uses the handoff ETH pool and the network's Universal Router, quoter and Permit2. Native buys send the input ETH and require no approvals. Token sells first approve the token to Permit2, then approve the router inside Permit2. Those are separate confirmed steps. Encoding uses `0x10` and actions `0x060c0f`; the extended tuple field is supported when the network declares it. Every execute/sell/claim/approve/transfer is simulated before signing.
- Quotes expire after 60 seconds; swaps/sales have a 120-second deadline. Slippage is user-controlled from 0.1% to 5%. Account, chain, amount and slippage changes invalidate quotes. Sub-unit output minimums are rejected. Transaction controls remain locked through receipt and allowance/balance refresh. Failed simulations, rejection, replacement, confirmation and revert states retain actionable feedback and transaction links.
- The deployment panel reads seller immutables, fee, per-claim gas limit, HARVEST metadata and connected token balances. A direct HARVEST transfer is exposed. Callback functions `executeSale` and `unlockCallback` are internal protocol plumbing and have no wallet controls. Neither application has owner settings.
- Reads use the public RPC list in order with fallback, bounded batches, explicit refresh and a 4-second receipt polling interval. No background reward polling floods the API. USD prices are not invented; the UI states their absence.

## Current external-service limitation and import fallback

The real browser test on 2026-10-08 confirmed that `explorer.imd.fun/api/earned` does not send `Access-Control-Allow-Origin` for the static site's origin. Direct automatic reward lookup therefore currently fails in a normal browser, while RPC reads and trading are available. The UI shows a persistent recoverable message and opens the importer. `api.imd.fun` also omitted a CORS header in the worker's HTTP check. Historical pool-log requests also remained unavailable on the configured RPCs during the final live bridge check, even after range reduction; discovered recent pools did not produce a usable bridge quote. Such routes stay excluded unless an exact, initialized and quotable bridge key is imported. These are upstream service settings; this static export cannot change them. There is no hidden CORS proxy.

Open the provided public-response links and paste the JSON. An earned response alone discovers rows. A bundle supplies per-launch records and proofs:

```json
{
  "earned": { "claimable": [], "unlocks": [] },
  "launches": {},
  "claims": {}
}
```

Key `launches` and `claims` by actual launch UUIDs and use the complete corresponding API response as each value. The empty objects above describe the format, not sample allocations. Only import public records for the currently viewed beneficiary. The frontend still cross-checks code, token identity, rounds and simulations; imported metadata is a user-provided discovery source, not a cryptographic attestation verifier.

For a less manual collection step, fetch public responses locally without CORS:

```sh
node scripts/collect-responses.mjs YOUR_WALLET_ADDRESS > /tmp/swarm-rewards.json
```

Replace `YOUR_WALLET_ADDRESS` with the address being viewed. This helper requires no key, wallet connection or RPC transaction. It collects the first 24 earned/unlocking launches; optionally give one actual launch UUID as the next argument. Paste its JSON into “Public API JSON” and select “Verify imported responses.” Real-browser evidence confirms this fallback resolved the live HARVEST allocation and withheld it while locked. Importing does not submit a transaction.

## Validation

```sh
npm run typecheck
npm test
npm run build
npm run verify
npm run check:format
```

Browser checks use an ephemeral foreground server at `/preview/` and mock wallet/RPC/services. They close the server and browser on completion:

```sh
PLAYWRIGHT_BROWSERS_PATH=/tmp/swarm-browser npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=/tmp/swarm-browser npm run test:browser
```

Optional read-only live checks:

```sh
npm run check:live
PLAYWRIGHT_BROWSERS_PATH=/tmp/swarm-browser node tests/live-browser.mjs
```

Evidence is in `docs/frontend/`; the consolidated review is `docs/frontend-validation.md`. The design system is documented at `docs/DESIGN.md`: the explicit allowed paths prohibit the otherwise requested root-level `DESIGN.md`. No mainnet transaction was broadcast. Publication, IPFS pinning, named hosting, screen-reader sessions, physical-wallet signing and funded end-to-end swaps are outside the worker's verified behavior. Absolute social image URLs remain pending the publisher's hosting domain; title, description, favicon and local assets are supplied.

Design guidance attribution and licenses are preserved in `docs/frontend/guide-licenses.txt`: Jakub Krehel's Better Interface (MIT, `267330e1adfc66a718fb65fa6918c1f06d0a689e`); Paul Bakaus's Impeccable documentation guide (Apache-2.0, `9d715cc4f5564a990ca8345abfdd5df6dc9b41c8`); Austin Griffith's Ethereum frontend UX guide (MIT, `06ea4efa08076ff04f6ca4945ef4a2ca881115b0`).
