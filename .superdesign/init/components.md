# CoveChat shared UI primitives

Framework: React 19 + TypeScript. Component library: custom primitives plus Lucide icons. No third-party component kit.

## `apps/web/src/ui-controls.tsx`

Shared button primitive used throughout chat, contacts, profile, dialogs, and admin surfaces.

```tsx
import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "small" | "medium" | "large";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  loading?: boolean;
  size?: ButtonSize;
  variant?: ButtonVariant;
};

export function Button({ children, className = "", disabled, icon, loading = false, size = "medium", variant = "primary", ...props }: ButtonProps) {
  return <button className={`ui-button ui-button-${variant} ui-button-${size} ${className}`.trim()} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
    {loading ? <span className="ui-button-spinner" aria-hidden="true" /> : icon}
    {children ? <span className="ui-button-label">{children}</span> : null}
  </button>;
}

export function IconButton({ className = "", children, ...props }: ButtonProps) {
  return <Button className={`icon-button ${className}`.trim()} variant="ghost" {...props}>{children}</Button>;
}
```

## Current implicit primitives to formalize

- Text field, search field, password field, select, textarea, checkbox and radio currently rely on scattered raw HTML and CSS.
- Dialog shells exist in `ProfileWorkspace.tsx`, `App.tsx`, and `deployment/DeploymentGate.tsx` but are not shared.
- Status banners, empty states, attachment cards, settings rows and destructive confirmations are repeated patterns.
- Redesign must turn these into explicit, styled components with labels, help text, errors, focus, loading and disabled states.
