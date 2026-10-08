# Swarm Harvester design

## Overview

Swarm Harvester helps identity.md contributors collect launch allocations and optionally convert their balances to IMD. The implemented direction is a calm, light workspace: warm paper surfaces, forest text, pale green actions, generous grouping and a restrained seed motif. This is an inferred direction for this assignment, not a separately approved brand identity.

The primary workspace pairs a rewards list with a conversion card. HARVEST trading, explanatory content and deployment details follow in normal document flow. Product concepts precede implementation details; exact contracts remain available in the deployment disclosure. Reuse the tokens in `web/src/styles.css`, the primitives in `web/src/components.tsx`, and the established pending/error patterns.

This document is under `docs/` because the explicit write scope excludes a root `DESIGN.md`.

## Colors

All functional colors are defined at the top of `web/src/styles.css` in hex notation. The interface intentionally has one light theme and no theme switch.

| Token | Value | Role |
| --- | --- | --- |
| `--page` | `#f5f6ef` | Whole-page background |
| `--surface` | `#fffef9` | Cards, inputs and outline buttons |
| `--surface-soft` | `#ecefe3` | Quiet insets, empty illustration, notices and segmented track |
| `--text` | `#202d25` | Headings, body text and active labels |
| `--muted` | `#5a655b` | Descriptions, captions and secondary labels |
| `--border` | `#d9ddcf` | Separators and card structure |
| `--border-control` | `#8e9989` | Input/outline control boundaries |
| `--accent` | `#d3ef94` | Main transaction action background |
| `--accent-hover` | `#c2e77a` | Enabled primary action hover |
| `--accent-text` | `#213c2a` | Text on the primary action |
| `--dark` | `#243f32` | Header connection / lookup action and motif |
| `--on-dark` | `#fffef9` | Text on dark controls |
| `--focus` | `#285ab6` | Keyboard focus ring |
| `--success-bg` / `--success-text` | `#e6efdc` / `#355124` | Explicit ready status |
| `--error-bg` / `--error-text` | `#fff0e9` / `#a03225` | Persistent error context |

The decorative seed grid and token-avatar backgrounds use a few local sage, wheat and gray values; they do not convey eligibility. Ready/error/locked status always has text. The browser report records measured rendered contrast pairs: muted text on page 5.60:1, body text on page 13.20:1, dark-button text 11.35:1, outline-button text 14.21:1, and fee-note text 6.03:1. These values concern those exact rendered pairs, not a claim about every possible state.

## Typography

The body stack is `'Segoe UI', Inter, -apple-system, BlinkMacSystemFont, sans-serif`; none of these is downloaded. The actual system face depends on the visitor's platform. Weights are CSS requests (400, 500, 550, 600, 650 and 750); there is no claim that a bundled variable face supplies each value. Font synthesis is disabled. Georgia/serif italic is used only for the decorative illustration caption; SFMono-Regular/Consolas/monospace is used for addresses and machine-readable values.

The root is 16px with a unitless 1.5 line-height. Headings descend from the responsive hero (`clamp(3.3rem, 6.4vw, 5.25rem)` in the base rule), through 1.6–2.25rem section headings, to 1rem row headings. Hero tracking is −0.065em and line-height 1.03; ordinary section headings use −0.035em and 1.2. At the mobile breakpoint the hero uses `clamp(3rem, 13vw, 3.6rem)`.

Functional captions have a 0.75rem floor. Inputs remain at least 1rem; the large trade amount is 1.7rem. Use `Amount` for `bigint` values: it formats token decimals without rounding through floating point, groups whole digits, limits the displayed fractional tail and provides the full amount in the title. Numeric values use tabular digits. Addresses have copy support, an explorer link and a full checksummed title; full deployment addresses are also printed in the disclosure.

Headings balance their lines, descriptions use pretty wrapping, addresses/IDs wrap when needed, and body copy stays within a readable measure (typically 390px, with importer instructions capped at 75ch). Text remains selectable. Do not hide critical values with an ellipsis without retaining their full form.

## Layout

`site-shell` centers a maximum 1248px layout with 44px desktop side padding, 28px at 68rem, 20px at 38rem and 16px at 22rem. The root spacing tokens are 4, 8, 12, 16, 24 and 32px; larger section separations are 38–72px. Related fields have 8–12px spacing; larger groups have 24px or more.

The hero and trade section use intrinsic grids: `repeat(auto-fit, minmax(min(100%, 24rem), 1fr))` and a corresponding 22rem minimum. This allows columns to collapse when text is enlarged. The reward/conversion workspace uses a 1.62:1 desktop split with a 24px gutter and becomes one column at 53rem. Metrics change from four to two columns at 53rem. At 38rem, the lookup stacks, reward values move below row names, explanatory cards stack, and decorative hero art is hidden. The existing media breakpoints are 68, 53, 38 and 22rem; use the actual content fit when extending them.

No transaction control is fixed to the viewport or hidden in sticky chrome. The document has one `main`, a first-focusable skip link, native forms/buttons/links and heading landmarks. Address fields, result feedback and action controls stay together. Expanded disclosures handle imports, upcoming unlocks, deployment details and transfers without a custom modal.

The production export was checked at 1280, 768, 390 and 320 CSS pixels, including populated reward/quote content, and at 640px with the root text enlarged to 200%. Native browser zoom and physical-device behavior were not tested; do not equate those checks.

## Elevation & Depth

The system is intentionally flat. Cards have a one-pixel structural border, with tonal differences providing separation. There are no shadows, overlays, backdrops or floating drawers. Do not add ornamental elevation to ordinary content. The only explicit high stacking treatment is the skip link when focused.

## Shapes

Cards use `--radius: 20px` (16px on narrow screens), buttons `--button-radius: 9px`, inputs 8px, small icon controls 6px, and circular step numerals/indicators. The seed motif uses a repeated rounded leaf shape and one asymmetric hero-art corner. The SVG mark in `web/public/mark.svg` is locally served and supplies the favicon and header/footer identity.

## Components

- **Button pattern**, `styles.css`: `.button` for outline actions, `.dark` for connection/lookup emphasis, `.primary` for the next transaction step, `.full` for card-width actions, `.text-button` for secondary actions. Minimum ordinary target height is 44px. Keep the action verb visible. Native disabled states prevent clicks; nearby text explains unmet prerequisites.
- **`WalletGate`**, `components.tsx`: shows connection before prerequisites, a wrong-network explanation pointing to the single header switch, then a disabled/available fieldset. Individual action handlers also validate current wallet state before signing.
- **`Feedback`**, `components.tsx`: a persistent polite live region with action-specific text, optional spinner, error and transaction explorer link. It persists across the wallet-to-receipt gap. Errors and confirmation links are not timed toasts.
- **`AddressLink`**, `components.tsx`: checksummed abbreviated address/link, explicit copy button and full value on clipboard failure. `label` can name a configured contract. Copy confirmation changes both icon and accessible label.
- **`Amount`**, `components.tsx`: decimal-aware display of exact integer token amounts, optional symbol, full-value title, tabular digits and a less-than display for very small positive amounts.
- **`Icon`**, `components.tsx`: a small local SVG set with 1.7px rounded strokes and `currentColor`; icons are decorative within named controls.
- **Reward row**, `App.tsx` and `.reward-row`: token identity, textual eligibility, allocation/balance, verification reason and a native claim checkbox. It is an application pattern, not an exported component API. Rows use the viewed beneficiary while seller actions require the connected caller.
- **Quote detail pattern**, `.quote-details`: labeled gross output, fee, net output, net minimum, validity and an expandable per-token route list. The minimum gets a structural divider. Exclusions are explicit and change the sale action label.
- **`Trade`**, `Trade.tsx`: native buy/sell buttons with `aria-pressed`, amount, slippage, balance, expiring quote and one approval/execute action at a time. Editing inputs or changing accounts invalidates the quote.
- **Disclosure pattern**, native `details/summary`: browser-provided keyboard handling with a visible disclosure marker. Avoid replacing it with clickable text or a custom role.

`:focus-visible` uses a 3px `--focus` outline with 4px offset. Forced colors uses system `Highlight`; controls retain borders. With reduced motion, indicators remain static but status text is preserved. Otherwise only named background/transform properties transition for 120ms, button presses use scale 0.96, and pending spinners rotate over one second. There are no animated entrances or autoplay content.

## Do's and Don'ts

Start a new section inside `site-shell`, reuse section/card spacing and the existing type roles, then add only the state it actually needs. Prefer a native control over a custom widget. Use an outline action for secondary paths and a single clear next action within each transaction flow. Keep mobile controls inset and allow grid children to shrink/wrap.

Keep deployment values in the generated runtime manifest; never put addresses or a second chain map in a visual component. Never use a ready color as a substitute for verified eligibility. Do not replace unknown balances with zero, imply an unavailable USD valuation, hide a skipped sale or clear transaction feedback before it can be read. Rebuild the static export and manifest together after changes.
