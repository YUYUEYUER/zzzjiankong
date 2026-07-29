# Design QA

- Source visual: live capture of `https://status.openai.com/` in the in-app browser.
- Implementation: Playwright captures of `http://localhost:8787/` using desktop 1280 x 900 and mobile 390 x 844 viewports.
- Responsive check: production build in Chromium with the Sub2API JSON-import and direct-login states open.
- Compared state: status overview, one expanded account, quick token form, Sub2API switch, JSON session import, direct account login, and advanced form handoff.

**Findings**

- No actionable P0, P1, or P2 findings remain.
- [Accepted] The reference uses uptime bars for public product availability. This balance monitor uses upstream and account rows instead, because balance, threshold state, per-Key usage, and multiplier are the actionable data.
- [Accepted] The OpenAI logo and product copy were not reproduced. The reference is used as the visual framework; the implementation retains its own Chinese product identity and operational copy.
- [Accepted] The overall banner changes from green to amber when a low-balance, stopped, or failed account needs attention. This is required product behavior rather than visual drift.

**Required Fidelity Surfaces**

- Fonts and typography: Inter Variable with Chinese system fallbacks, fixed font sizes, zero negative letter spacing, and clear heading/body/metadata hierarchy. Long account and host labels truncate without displacing balances or actions.
- Spacing and layout: centered single column, generous top spacing, one summary banner, one bordered status group, thin dividers, 8px maximum card radius, and quiet row density follow the reference. Desktop capture showed no overlap or horizontal overflow.
- Colors and tokens: white background, near-black commands, neutral gray dividers, restrained green success, amber attention, and red failure states. No gradients, glass effects, or decorative color fields remain in the main page.
- Image and icon fidelity: the source contains no required product imagery beyond its own brand mark. The implementation uses Phosphor icons consistently and does not introduce handcrafted SVG or placeholder imagery.
- Copy and content: every visible sentence describes current balance state, monitoring, alerts, recharge recovery, or account setup. The screen does not contain feature-tour or design-explanation copy.
- Interaction states: upstream banner opens edit, plus opens the quick official-token form, New API/Sub2API switching updates required fields, Advanced preserves the draft and opens the full form, account rows expand, refresh actions work, and alert history expands in place.
- Accessibility and responsiveness: semantic buttons and labels are present, focus rings are visible, reduced motion is supported, and the 375px check reported no horizontal overflow and zero visible buttons below 44 x 44px.

**Fixes Applied During QA**

- Increased all visible mobile action targets to at least 44 x 44px.
- Kept the notification, security, 2FA, and proxy settings entry visible at 375px.
- Kept account actions hidden on mobile until expansion to preserve scan density.
- Stacked per-Key metrics and compact account details on narrow screens.
- Verified the quick-token modal remains fully scrollable inside a 375 x 812 viewport.
- Prevented 30-second dashboard refreshes from clearing an open account form.
- Replaced the account form's upstream dropdown with an editable name field; existing names are reused and new names are created atomically with the account.
- Prevented missing balances and multipliers from being rendered as zero.
- Added official New API account-token inventory so the default setup can expand into per-Key usage and group multipliers.
- Invalidated expanded Key data after account sync/edit and allowed collapse/reopen retries.
- Filtered demo totals and incidents whenever real accounts are present.
- Added restrained nonlinear easing to account expansion, summary-state changes, and modal entry.
- Added a compact JSON session importer directly below the Sub2API API-token field; filename and AT/RT availability remain readable without exposing token values.
- Added direct Sub2API account login in the same form, with explicit email/password fields and a distinct “登录并添加” action state.
- Made the quick form internally scrollable and changed mobile actions to normal document flow; coordinate checks confirmed zero overlap between password fields and actions.
- Added an expanded all-group multiplier table with base, user override, peak-window, and current effective rates before per-Key usage.
- Removed the old side navigation, charts, glass surfaces, and multi-column workspace from the main experience.

**Follow-up Polish**

- [P3] Historical balance bars can be added later only if they are backed by a clearly defined period and availability calculation.

final result: passed
