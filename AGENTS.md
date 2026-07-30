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
