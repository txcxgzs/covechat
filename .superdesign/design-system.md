# CoveChat Interface System — Northstar

## Product character

CoveChat is a serious private messenger, not a generic admin dashboard. The interface should feel calm, fast, tactile and trustworthy. Information density may approach Telegram Desktop, while visual hierarchy and safety communication must remain clearer. No raw database identifiers, placeholder controls, exposed configuration fields, or permanent forms for actions that belong in dialogs.

## Typography

- Bundle and use `Manrope Variable` for Latin/numeric UI and `Noto Sans SC Variable` for Chinese. Never fall back to browser-default typography as the intended appearance.
- UI stack: `"Manrope Variable", "Noto Sans SC Variable", sans-serif`.
- Display: 28/34, 720 weight, -0.025em tracking.
- Section heading: 18/24, 700.
- Body: 14/21, 480; never smaller than 13px for primary content.
- Caption: 12/17, 560. Do not use faint tiny text to hide complexity.
- Monospace is reserved for cryptographic fingerprints and audit data, never usernames or normal labels.

## Color

- Ink 950 `#0B2033`, ink 800 `#173B52`, muted `#647D8C`.
- Cove teal 700 `#087F7E`, 600 `#0E9997`, 400 `#45C9C5`, 100 `#DDF4F1`, 50 `#F1FAF8`.
- Canvas `#EDF6F8`, surface `#FFFDF9`, elevated `#FFFFFF`, line `#D8E6E8`.
- Danger `#C33F50`, danger surface `#FFF0F1`; warning `#C76537`, warning surface `#FFF5EE`.
- Dark mode uses ink-blue surfaces, not neutral black, and preserves teal contrast.

## Spacing and geometry

- 4px base grid. Core steps: 4, 8, 12, 16, 20, 24, 32, 40.
- Interactive targets: minimum 44×44 desktop and 48×48 touch.
- Radius: controls 12px, cards 18px, large dialogs/drawers 24px, pills 999px.
- Borders are subtle and paired with surface contrast; never outline every container.
- Shadows use two navy-tinted layers, never default gray box-shadow.

## Form controls

- No naked browser inputs/selects. Every control has a designed wrapper, visible label or explicit accessible label, focus ring, hover, filled, error, disabled and loading state.
- Text fields use 48px height, leading icon or contextual prefix only when meaningful, 14px horizontal padding, and a 3px translucent teal focus halo.
- Password actions appear in a focused modal or sheet opened from a settings row; never expose old/new password fields permanently.
- Selects use a custom trigger and popover/listbox. Native select may remain only as a progressively enhanced hidden control.
- Destructive confirmations state impact, scope and recovery status; confirmation input is used only for irreversible account deletion.

## Navigation

- Desktop: 84–92px branded rail, 320–344px list pane, flexible conversation, optional 340px context drawer.
- Mobile: persistent five-item bottom navigation; contextual lists open as drawers. Composer and destructive actions must never sit behind the bottom bar.
- Active state combines shape, color and position; do not rely on color alone.

## Messaging surfaces

- Conversation rows expose identity, preview, time, delivery/unread state and mute state without visual noise.
- Bubbles cap at readable measure, wrap long content safely and use sender-aware corner geometry.
- Attachments are first-class message cards with type icon, filename, human-readable size, progress and explicit download state.
- Search is inline and keyboard-friendly, with result count and next/previous navigation.
- Empty states teach the next action and provide exactly one strong CTA.

## Dialogs, drawers and feedback

- Use modal dialogs for focused edits, side drawers for contextual inspection, bottom sheets for mobile actions, and toasts/status banners for short outcomes.
- Escape, backdrop click and explicit close are supported when safe. Focus is trapped and restored.
- Async actions replace the action icon with progress, preserve the label, and prevent duplicate submission.
- Errors are specific, placed near the failed action, and offer a recovery path.

## Motion

- Navigation 160–220ms; drawers 240–300ms using a restrained spring; message entry 180–240ms.
- Motion communicates origin and state. Never animate every card on every render.
- Respect reduced motion and keep focus/state changes visible without animation.

## Accessibility and maturity gates

- WCAG AA contrast, visible keyboard focus, semantic labels, 200% zoom support and 390px layout without horizontal scrolling.
- No internal IDs presented as people-facing names.
- No icon-only destructive action without label or confirmation.
- Every empty/loading/error/disabled/offline state is intentionally designed.
- Chinese and English strings must both fit without clipping.
