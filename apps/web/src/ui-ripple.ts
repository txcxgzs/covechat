export function installUiRipple(): () => void {
  const handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>("button, [data-ripple]")
      : null;
    if (!target || target.matches(":disabled") || target.closest(".motion-disabled")) return;
    const bounds = target.getBoundingClientRect();
    const diameter = Math.ceil(Math.hypot(bounds.width, bounds.height) * 2);
    const ripple = document.createElement("span");
    ripple.className = "ui-ripple";
    ripple.style.width = `${diameter}px`;
    ripple.style.height = `${diameter}px`;
    ripple.style.left = `${event.clientX - bounds.left - diameter / 2}px`;
    ripple.style.top = `${event.clientY - bounds.top - diameter / 2}px`;
    target.append(ripple);
    ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
  };
  document.addEventListener("pointerdown", handlePointerDown, { passive: true });
  return () => document.removeEventListener("pointerdown", handlePointerDown);
}
