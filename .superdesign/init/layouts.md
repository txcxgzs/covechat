# CoveChat shared layouts

## Application shell — `apps/web/src/App.tsx`

The authenticated shell is a four-surface workspace: desktop rail navigation, optional list/sidebar, main content, optional details drawer. Mobile uses a persistent five-item bottom navigation plus contextual drawers.

```tsx
function Navigation({ activeView, onViewChange, ...props }) {
  const nav = [
    { id: "messages", label: "消息", icon: MessageCircle },
    { id: "contacts", label: "联系人", icon: UserRound },
    { id: "groups", label: "群组", icon: UsersRound },
    { id: "settings", label: "设置", icon: Settings },
  ];
  return <nav className="navigation" aria-label="Primary">{/* brand, nav, sound, language, profile */}</nav>;
}

function MobileBottomNavigation({ activeView, onViewChange, t }) {
  return <nav className="mobile-bottom-navigation" aria-label={t("mobileNavigation")}>{/* five labeled destinations */}</nav>;
}

export function App({ profile, session }) {
  return <div className="app"><div className="workspace">
    <Navigation />
    {/* messages: conversation list + chat + security drawer */}
    {/* contacts, groups, settings, and profile workspaces */}
    <MobileBottomNavigation />
  </div></div>;
}
```

## Page shells

- `SecurityGate.tsx`: centered secure onboarding/unlock card.
- `DeploymentGate.tsx`: centered first-run deployment configuration card.
- `AdminApp.tsx`: admin side navigation + page header + content tables/cards.
- `ContactsWorkspace.tsx`: hero, add-contact panel, requests and contact grid.
- `ProfileWorkspace.tsx`: account hero, grouped settings rows, modal dialogs.
- `GroupWorkspace` in `App.tsx`: group drawer, group conversation and group-management drawer.

The monolithic `App.tsx` is 1500+ lines. Design commands must use line ranges for the exact rendered branch and pair them with the relevant CSS ranges, per Superdesign payload rules.
