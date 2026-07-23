# CoveChat routes and view mapping

The Vite SPA does not use React Router. `apps/web/src/main.tsx` selects the root surface.

- `/` — deployment gate when the site is unconfigured; otherwise `SecurityGate`, then authenticated `App`.
- `/${VITE_ADMIN_PATH}` — `AdminApp`, protected by an independent administrator token.
- Authenticated in-app views are state-driven: `messages`, `contacts`, `groups`, `settings`, `profile`.
- Mobile and desktop render the same semantic views with responsive layout rules in `apps/web/src/styles.css`.

Key files:

- `apps/web/src/main.tsx`
- `apps/web/src/App.tsx`
- `apps/web/src/security/SecurityGate.tsx`
- `apps/web/src/deployment/DeploymentGate.tsx`
- `apps/web/src/AdminApp.tsx`
