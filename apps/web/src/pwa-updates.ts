export const PWA_UPDATE_READY_EVENT = "covechat:pwa-update-ready";
export const PWA_APPLY_UPDATE_EVENT = "covechat:pwa-apply-update";

type TrustedTypesFactory = {
  createPolicy: (
    name: string,
    rules: { createScriptURL: (value: string) => string },
  ) => { createScriptURL: (value: string) => unknown };
};

export async function initializePwaUpdates(): Promise<void> {
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  const trustedTypes = (window as typeof window & { trustedTypes?: TrustedTypesFactory }).trustedTypes;
  const workerUrl = trustedTypes
    ? trustedTypes.createPolicy("covechat#pwa", { createScriptURL: (value) => value }).createScriptURL("/sw.js")
    : "/sw.js";
  const registration = await navigator.serviceWorker.register(workerUrl as string);
  const announceWaitingWorker = () => {
    if (registration.waiting) window.dispatchEvent(new Event(PWA_UPDATE_READY_EVENT));
  };
  announceWaitingWorker();
  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      if (installing.state === "installed" && navigator.serviceWorker.controller) {
        announceWaitingWorker();
      }
    });
  });
  window.addEventListener(PWA_APPLY_UPDATE_EVENT, () => {
    registration.waiting?.postMessage({ type: "SKIP_WAITING" });
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}
