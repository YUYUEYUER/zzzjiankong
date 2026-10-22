# Prototype Instructions

Run the local server yourself and open the preview in the in-app browser. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Locked Product Direction

- Visual target: `../design/reference/frosted-console-target.png`.
- Product name: `霜镜`.
- Direction: bright silver-white spatial workspace with restrained liquid-glass material.
- Core workflow: account connection -> raw balance -> arithmetic conversion -> CNY threshold -> Resend/Feishu alert -> manual recharge -> two healthy polls -> automatic closure.
- Do not store or seed credentials supplied in conversation.

## Usability Direction

- Treat `Upstream` as the first-level operational object and `Account` as a child identity.
- The first screen must answer which upstream needs attention before showing account formulas or trends.
- Real upstreams take priority; demo data stays hidden by default when real data exists.
- Upstream creation and renaming must be explicit, discoverable, and fully functional.
- Accounts with a saved browser session must expose a direct "enter upstream" action that reuses the original browser profile and cookies instead of creating a second login identity.
- Linux server deployment must keep Chromium headed and expose its persistent desktop through the authenticated application domain; headless Chromium is not an acceptable Cloudflare login path.
- Prefer readable tables and solid data surfaces over decorative glass. Keep glass restrained to navigation, top bars, and modals.
- Do not render controls that only look interactive. Every visible navigation item, filter, menu, and action must work or be removed.

## First-use Experience

- Prioritize first-use guidance before broader feature expansion: create an upstream, connect an account, verify the converted balance and thresholds, then configure notifications.
- Derive progress from real saved configuration. Demo accounts and failed polls must not count as successful setup; notification configuration must not be described as a successful delivery test.
- Let users pause and resume onboarding, keep errors visible with a recovery action, and retain access to the normal monitoring workspace.
- Keep the dashboard's overall status banner compact: modest height, tighter vertical padding and text spacing, leaving room for the upstream list.
- Offer examples only before the first real upstream is configured. Once real setup begins, hide both example data and the example toggle from everyday use.
- Preserve the existing centered login/admin setup layout. The user only wants its blue “霜” logo tile and blue glow changed to neutral dark grey; do not add illustrations or redesign it as a split layout.
- Unify dropdowns across the app with compact white menus, subtle grey borders and grey selection highlights. Keep native keyboard operation, disabled options and required-field validation; avoid the large blue system popup in supported browsers.
- Recovery confirmation counts support common presets and a custom positive integer; retain the existing default of two consecutive healthy polls.
