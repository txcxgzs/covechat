import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "small" | "medium" | "large";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  loading?: boolean;
  size?: ButtonSize;
  variant?: ButtonVariant;
};

export function Button({
  children,
  className = "",
  disabled,
  icon,
  loading = false,
  size = "medium",
  variant = "primary",
  ...props
}: ButtonProps) {
  return (
    <button
      className={`ui-button ui-button-${variant} ui-button-${size} ${className}`.trim()}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <span className="ui-button-spinner" aria-hidden="true" /> : icon}
      {children ? <span className="ui-button-label">{children}</span> : null}
    </button>
  );
}

export function IconButton({ className = "", children, ...props }: ButtonProps) {
  return <Button className={`icon-button ${className}`.trim()} variant="ghost" {...props}>{children}</Button>;
}
