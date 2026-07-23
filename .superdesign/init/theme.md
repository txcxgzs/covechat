# CoveChat current theme evidence

## Compact token summary

- CSS approach: one global vanilla CSS file, `apps/web/src/styles.css` (916 lines), plus semantic class names.
- Current fonts: system stack (`Inter`, `Segoe UI`, sans-serif fallback); this must be replaced with bundled, explicit brand typography.
- Brand colors: deep navy `#0b263c` / `#173047`, teal `#159b9a`, bright teal `#3fd2cf`, pale teal `#dff3f1`.
- Surfaces: warm white `#fffefb`, white cards, blue-gray chat canvas `#eef7fb`.
- Text: ink `#173047`, muted `#6f8492`, danger `#c13c47`, warning `#d55c4d`.
- Radius language: 8–24px; avatars and primary create actions are circular.
- Shadows: blue/navy tinted, low-opacity, layered; drawers use directional shadows.
- Motion: 140–360ms, spring curve stored in `--motion-spring`; reduced-motion class collapses durations.
- Breakpoints: 1160px compact desktop; 760px mobile.

## Raw source authority

The complete current token and component source is `apps/web/src/styles.css`. It is deliberately not duplicated here because it exceeds the 900-line Superdesign payload threshold. Design calls must pass token ranges `apps/web/src/styles.css:1:90` plus only the selectors used by the target surface, and may use this compact summary as additional context.

Primary variable block begins at line 1 and includes `--navy`, `--teal`, `--teal-bright`, `--teal-soft`, `--ink`, `--muted`, `--line`, `--surface`, `--chat-canvas`, typography sizes, and motion tokens.
