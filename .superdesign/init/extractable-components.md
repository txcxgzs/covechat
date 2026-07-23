# Reusable Superdesign component candidates

## DesktopNavigation
- Source: `apps/web/src/App.tsx`
- Category: layout
- Description: Navy vertical brand rail with four primary destinations and account utilities.
- Extractable props: `activeItem` (string, default `messages`).
- Hardcoded: brand shield, labels, Lucide icon choices, CSS classes.

## MobileBottomNavigation
- Source: `apps/web/src/App.tsx`
- Category: layout
- Description: Floating five-destination mobile navigation with active capsule.
- Extractable props: `activeItem` (string, default `messages`).
- Hardcoded: destination labels and icons.

## ConversationSidebar
- Source: `apps/web/src/App.tsx`
- Category: layout
- Description: Conversation heading, compose action, search and thread list.
- Extractable props: `activeItem`, `badgeCount`.
- Hardcoded: search affordance and conversation row anatomy.

## SecurityDrawer
- Source: `apps/web/src/App.tsx`
- Category: layout
- Description: Contextual identity, safety-number, device and privacy actions drawer.
- Extractable props: `isExpanded` (boolean, default `true`).
- Hardcoded: security section structure and icons.

## Button
- Source: `apps/web/src/ui-controls.tsx`
- Category: basic
- Description: Four visual variants, three sizes, icon and loading support.

## AccountDialog
- Source: `apps/web/src/ProfileWorkspace.tsx`
- Category: basic
- Description: Modal shell for passphrase, recovery, devices and destructive actions.
- Extractable props: `isExpanded` (boolean, default `true`).
