# CoveChat page dependency trees

## `/` — authenticated messaging workspace

Entry: `apps/web/src/main.tsx`

- `apps/web/src/App.tsx`
  - `apps/web/src/ui-controls.tsx`
  - `apps/web/src/ContactsWorkspace.tsx`
  - `apps/web/src/ProfileWorkspace.tsx`
  - `apps/web/src/security/SecurityGate.tsx`
  - `apps/web/src/deployment/DeploymentGate.tsx`
  - `apps/web/src/i18n.ts`
  - `apps/web/src/data.ts`
  - `apps/web/src/styles.css`
  - `lucide-react`

## `/` — onboarding, recovery and unlock

- `apps/web/src/security/SecurityGate.tsx`
  - `apps/web/src/i18n.ts`
  - `apps/web/src/styles.css`

## Contacts

- `apps/web/src/ContactsWorkspace.tsx`
  - `apps/web/src/ui-controls.tsx`
  - `apps/web/src/styles.css`
  - `lucide-react`

## Profile and security

- `apps/web/src/ProfileWorkspace.tsx`
  - `apps/web/src/ui-controls.tsx`
  - `apps/web/src/styles.css`
  - `lucide-react`

## Groups

- `GroupWorkspace` render branch in `apps/web/src/App.tsx` (approximately lines 830–1210)
  - `apps/web/src/ui-controls.tsx`
  - `apps/web/src/i18n.ts`
  - `apps/web/src/styles.css`
  - `lucide-react`

## Admin

- `apps/web/src/AdminApp.tsx`
  - `apps/web/src/ui-controls.tsx`
  - `apps/web/src/admin-api.ts`
  - `apps/web/src/styles.css`
