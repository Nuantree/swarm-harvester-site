# Frontend validation and Better Interface review

Worker report, 2026-10-08. This is local evidence, not an independent audit or publication certification.

## Scope and delivery

Implemented one static page covering wallet/address lookup, batch claims, balances, token approvals and sales to IMD, HARVEST/ETH swaps, HARVEST transfers, deployment observability and recoverable service failures. Source, lockfile and configuration are under `web/`; the production export is `dist/`. The approved workflow distinguishes the native ETH HARVEST pool from SwarmSeller's separate IMD conversion routes.

The final source was built locally and reviewed against the pinned Better Interface workflow and the core principles of all six domains, plus the pinned Ethereum frontend UX guide. No guide was fetched from upstream. Inferred design choices: light-only, system fonts, green/paper palette, no modal flow, local SVG/CSS illustration and native disclosures. The implementation does not change application contracts, constructor arguments, Solidity tests, root README/configuration, libraries or GitHub configuration. Root README already states the ETH pairing. `docs/DESIGN.md` supplies the requested design documentation within the explicit path budget; a root-level `DESIGN.md` is prohibited by that budget.

## Executed checks

| Check | Actual result |
| --- | --- |
| `npm run build --prefix web` | Passed. Includes strict TypeScript `tsc --noEmit`, Vite production build, pinned ABI extraction and manifest verification. Relative base `./`; no rewrite-dependent routes. |
| `npm test --prefix web` | Passed: 9 tests. Exact integer minimum/burn rounding; native and extended router encoding; missing-chain add/switch; rejected switching; nonzero/ambiguous round matching; malformed discovery data and paths; pool sorting/hook identity; historical log-range failure and dry-pool fallback. |
| `PLAYWRIGHT_BROWSERS_PATH=/tmp/swarm-browser npm run test:browser --prefix web` | Passed: 8 interaction scenarios plus 2 axe scans (10 report entries), Chromium 141.0.7390.37, served under `/preview/`. No JS page errors or failed static resources. Mocked external failures are intentional in the recovery scenario. |
| `npm run verify --prefix web` | Passed. Exact contract set, identifiers, ABI canonical Keccak hashes, handoff pool key, network and wallet-add object. Every exported file other than the manifest has a matching lowercase SHA-256 entry. 9 assets, 554,161 inventoried bytes before the small manifest. |
| `npm run check:format --prefix web` | Passed on final source, scripts, tests and Vite configuration. |
| `npm run check:live --prefix web` | Read-only checks: deployed contracts/dependencies and seller immutables passed; pool initialization passed; HARVEST quote for 0.001 ETH passed; public proof/root/round matching passed. Historical ETH/IMD bridge discovery remained unavailable; details below. The script records individual outcomes, not a blanket success assertion. |
| `PLAYWRIGHT_BROWSERS_PATH=/tmp/swarm-browser node web/tests/live-browser.mjs` | Live RPC verification rendered successfully. Real API CORS failure reproduced. Imported actual launch/claim responses matched live on-chain state and displayed the HARVEST allocation as locked before its unlock. No wallet connected or transaction broadcast. |
| `node web/scripts/collect-responses.mjs <public address> <actual launch UUID>` | Passed against the current launch: one launch record and one proof response, output only to `/tmp/swarm-rewards.json`. No private key or transaction. |

The supplied MCP browser tool could not launch because `/home/seat/.cache/ms-playwright/chromium-1246/chrome-linux64/chrome` was absent. Browser coverage was performed using Playwright's locally installed Chromium under `/tmp/swarm-browser`. Each browser script owns a bounded foreground preview/browser and closes both; no persistent server was left running.

Interaction coverage included:

- No wallet, invalid address with restored field focus, disconnected empty state and keyboard skip navigation.
- Wrong chain with a simulated 4902, exact `wallet_addEthereumChain` object, second switch and re-enabled action. The mocked proof deliberately matched round **1**, demonstrating that round zero is not assumed.
- Claim transaction encoding, named beneficiary, receipt log parsing and refreshed claimed flags/balances.
- Multi-hop quote, exact seller approval, rejected signature recovery, disabled approval during delayed receipt, fresh quote after approval, simulated minimum-output revert preventing signing, net-protected sale and receipt outcome display.
- Native HARVEST purchase with `value=amountIn`, no approvals, configured Universal Router and exact handoff hook in calldata.
- HARVEST sale's separate ERC20-to-Permit2 and Permit2-to-router approvals, plus invalidation when slippage or the wallet account changes.
- Failed API recovery via imported responses; a viewed beneficiary distinct from the gas-paying caller; zero-rounded output rejection; expiration removing the approval action; transfer amount/recipient encoding.

Browser fixtures live only under `web/tests/` and are not imported by production source or included in `dist/`. Their balances, proofs and receipts are synthetic test evidence, not live allocations or financial results.

## Six-domain coverage

| Domain | Coverage and evidence | Limits |
| --- | --- | --- |
| Accessibility | Checked native semantics, visible labels, error association, focus styles, disabled state and polite status regions in source. Keyboard skip/link focus and invalid-field focus exercised; actual screenshots inspected. Axe found zero violations in disconnected desktop and connected quoted-sale states. Forced-colors control boundaries were checked. | No screen-reader session, switch control, physical mobile device or exhaustive keyboard-only signing session. Axe is not full accessibility certification. |
| Layout | Checked desktop 1280, intermediate 768, mobile 390 and narrow 320 CSS pixels for empty and populated quotes. No horizontal overflow. Checked 640px with root text enlarged to 200%. Intrinsic grids and logical spacing keep controls in document flow. | Text enlargement is not native browser zoom. English/LTR only; no RTL/localization claim. |
| Writing | Reviewed every primary action, fee, gross/net minimum, recipient explanation, error recovery and excluded-token message. Explicit ETH pairing, IMD conversion, USD unavailability and missing-service guidance. | External RPC/wallet messages may vary; fallback messages remain bounded and persistent. |
| Typography | Checked descending hierarchy, system-family declarations, unitless leading, headings, long addresses, selectable content and tabular amounts. Raised functional captions to at least 0.75rem and kept inputs at 1rem. Screenshots checked after correction. | Exact system face/weight varies across operating systems. No bundled font-loading assertion. |
| Colors | Semantic role tokens reviewed; measured actual rendered foreground/background pairs in the browser (see report and table below). Both axe scans include contrast checks. State also uses text/icons. | Single implemented light theme. Focus was visually observed on the page surface; every possible focused/background combination was not individually measured. |
| UI | Walked empty, loading, ready, disabled, rejected, simulated-failure, pending receipt, confirmed and expired states. Verified mobile disclosures and quote grouping. Motion is restricted by `prefers-reduced-motion`; no entry animation or autoplay. | No animation-panel slow replay; reduced motion was enabled during automated screenshots. Native wallet confirmation UI is outside the page test. |

Measured rendered pairs (WCAG relative-luminance calculation, no estimates):

| Pair | Ratio |
| --- | ---: |
| Muted hero / page | 5.60:1 |
| Heading / page | 13.20:1 |
| Outline action / surface | 14.21:1 |
| Dark action text / dark action fill | 11.35:1 |
| Metric label / page | 5.60:1 |
| Fee note / card surface | 6.03:1 |

## Findings corrected and rechecked

| Severity / domain | Final source location | Observed finding and repair |
| --- | --- | --- |
| Medium / accessibility | `web/src/App.tsx:82` | Invalid-address focus was requested while the field was still disabled. Moved focus into a post-render effect. Browser now confirms focus and `aria-invalid`. |
| Medium / layout | `web/src/styles.css:1558` | At 640px with 200% text, the document reached 699px width. Hero/trade now use intrinsic grids with shrinkable children. Recheck reports no overflow at that setting and at 320px. |
| Medium / writing | `web/src/App.tsx:1015`, `web/src/App.tsx:1391` | Hiding a line break on mobile joined “tokens.One” and “harvest.You’re”. Added real whitespace; final screenshots show separate words. |
| Medium / typography | `web/src/styles.css:475`, `web/src/styles.css:725`, `web/src/styles.css:830` | Compact captions, address links and fee notes fell below the intended functional-text floor. Raised small text to 0.75rem, preserving 1rem inputs. Rechecked populated mobile reflow and axe. |
| Medium / UI | `web/src/Trade.tsx:245` | Clearing the amount after a swap triggered the input-change effect and erased the confirmation. Keep the reviewed amount and receipt status; the browser confirms the success message remains visible. |
| High / interaction integrity | `web/src/App.tsx:302` | Async balance refresh could repopulate an old wallet's rows after an identity change. Applied a generation guard to refresh results; account changes also invalidate both quote flows. |
| Medium / data reliability | `web/src/rewards.ts:401` | A 50,000-block discovery request was rejected by the configured RPC. Queries now use at most 10,000 blocks and recursively split refused ranges. The unit test verifies range handling and skipping dry pools. The remaining live historical-RPC failure is disclosed rather than replaced by a guessed pool. |
| Medium / transaction integrity | `web/src/Trade.tsx:145` | Very small positive quotes can round their minimum to zero. Reject those quotes before approval/signing. Browser scenario verifies rejection and separately verifies quote expiry disables approval. |
| Low / UI | `web/src/Trade.tsx:362`, `web/src/App.tsx:1089` | The first render of a quote could show 61 seconds because the display timer predated its timestamp. Clamp the remaining display to 60 seconds. |

## Evidence files

- `docs/frontend/browser-report.json`: final mocked scenarios, axe outcomes, computed contrast and empty JS/static-resource error lists.
- `docs/frontend/desktop.png`, `mobile.png`: final disconnected production page, with visible keyboard focus.
- `docs/frontend/quoted-sale.png`, `mobile-quote.png`: final populated quote/receipt state, using clearly documented mocked balances.
- `docs/frontend/live-check.json`: actual RPC/contract/quote/API read results, including unavailable bridge history.
- `docs/frontend/live-browser.json`, `live-import.png`: actual CORS error and successfully verified imported live allocation. Expected CORS console/resource failures are preserved here, separately from the mocked suite's clean static-resource results.
- `docs/DESIGN.md`: source-derived tokens, typography, patterns and responsive behavior.
- `docs/frontend/guide-licenses.txt`: pinned guide license notices and attribution.

## Remaining limits and completion

**Complete for the worker's implementation/export/validation scope, with external-service limitations.** Automatic reward fetching is currently blocked by the earned API's missing CORS header. The browser importer and optional local public-response collector provide a tested recovery path. The publisher or API operator must enable CORS for automatic browser lookup; the worker cannot configure that service.

The configured RPCs returned recent ETH/IMD initialization events, but the pools tested did not produce a usable bridge quote. Further historical log requests were rejected with the provider's range-limit error even after splitting to a 625-block span. Thus this worker does not claim a live end-to-end IMD conversion. The UI keeps such rows excluded and accepts an exact on-chain bridge key for validation/quoting; it never inserts an assumed fee/hook. Direct routes and the full seller interaction are covered with mocks. The live HARVEST/ETH quote did succeed.

No funded mainnet action was sent. Actual inclusion, economic execution, all third-party token behavior, unavailable RPC history, native-wallet UI and transaction replacement under a real wallet remain unverified. Token approvals persist until spent/revoked; the UI does not imply local disconnect revokes on-chain approvals. IPFS pinning, site naming, published URLs/CIDs, HTTP asset checks after publication and a final hosting domain/social-image URL belong to the publisher. No publication step is claimed.

The workspace's Git metadata is read-only. Delivery files are prepared in the allowed paths for the contributor publisher to capture; no workspace Git commit or remote publication was attempted. The final scope/size record accompanies this report.
