# Design QA

- Source visual truth path: `E:\查看上游余额\design\reference\frosted-console-target.png`
- Implementation screenshot path: `E:\查看上游余额\app\design\final-desktop-1440x1024.png`
- Mobile screenshot path: `E:\查看上游余额\app\design\final-mobile-390x844.png`
- Full-view comparison: `E:\查看上游余额\app\design\qa-side-by-side.png`
- Focused comparison: `E:\查看上游余额\app\design\qa-focused-main.png`
- Viewport: 1440 x 1024 desktop; 390 x 844 mobile
- State: seeded desktop overview, `east-prod` selected, connection inspector open, incident queue visible

**Findings**

- No actionable P0, P1, or P2 findings remain.
- [Accepted] The implementation shows the raw New API value as `quota` and applies `x / 500000 * 7.2`. The source mock labels the raw value as USD while using the same quota formula. The implementation intentionally follows the confirmed product behavior rather than preserving that inconsistent mock label.
- [Accepted] The implementation uses slightly tighter vertical spacing in the chart and inspector. This keeps the account workspace, formula tester, closed-loop timeline, and incident queue visible together at 1440 x 1024 without clipping.
- [Accepted] Timeline copy is shorter than the generated mock, but all required states remain visible and functional: threshold trigger, Resend, Feishu, manual recharge, two recovery confirmations, and automatic closure.

**Required Fidelity Surfaces**

- Fonts and typography: Inter Variable with Chinese system fallbacks preserves the target's compact product typography, numeric hierarchy, zero negative letter spacing, and readable 9-16px operational scale. No clipping or unintended wrapping was found.
- Spacing and layout rhythm: top glass shelf, slim icon rail, 250px account map, flexible center workspace, 310px inspector, and bottom queue match the source hierarchy. Radii remain at 8px or less. Desktop and mobile layouts do not overlap.
- Colors and visual tokens: frost-white base, cobalt selection, coral alerts, emerald recovery, ink text, translucent surfaces, and fine dividers match the target. Contrast remains readable across status states.
- Image quality and asset fidelity: the source contains no photographic or illustrative image assets. The implementation uses the Phosphor icon library for visible icons and Canvas chart rendering for stable screenshots; no placeholder imagery, handcrafted SVG, or inline SVG substitutes were introduced.
- Copy and content: Chinese operational labels are coherent and reflect the actual workflow. The conversion labels were corrected to distinguish raw quota from final CNY.
- Interaction states: account selection, search, tabs, range selector, formula test, add/edit modal, credentials visibility, notification settings, manual sync, acknowledgement, demo recharge, recovery confirmation, and automatic closure were exercised.
- Accessibility and responsiveness: semantic buttons and form labels are present, keyboard focus is visible, reduced-motion is supported, and the 390px layout exposes both the account map and selected workspace in the first viewport.

**Patches Made During QA**

- Removed core-workspace entrance opacity that could leave a background Chrome tab visually blank.
- Replaced the SVG trend renderer with Chart.js Canvas rendering for stable cross-browser capture.
- Disabled chart animation and waited for deterministic chart completion before capture.
- Prevented the demo offline account from creating a new incident during the reference state.
- Reduced the mobile account map height and prevented the workspace switcher label from wrapping.
- Moved the demo recharge control into the formula tester so it no longer overlaps the chart axis.
- Split vendor bundles to remove the original oversized single JavaScript bundle.

**Follow-up Polish**

- [P3] A future pass could add slightly stronger edge refraction to the glass surfaces on high-end displays.
- [P3] The inspector could optionally expose longer delivery metadata when the user expands an event.

final result: passed
