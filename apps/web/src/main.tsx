import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "virtual:pwa-register";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

type TrustedTypesFactory = {
  createPolicy: (
    name: string,
    rules: { createScriptURL: (value: string) => string },
  ) => { createScriptURL: (value: string) => unknown };
};

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  const trustedTypes = (window as typeof window & { trustedTypes?: TrustedTypesFactory }).trustedTypes;
  const workerUrl = trustedTypes
    ? trustedTypes.createPolicy("covechat#pwa", { createScriptURL: (value) => value }).createScriptURL("/sw.js")
    : "/sw.js";
  void navigator.serviceWorker.register(workerUrl as string);
}
