import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AdminApp } from "./AdminApp";
import { initializePwaUpdates } from "./pwa-updates";
import "./styles.css";

const adminPath = (import.meta.env.VITE_ADMIN_PATH || "/manage-cove").replace(/\/$/, "");
const RootApp = window.location.pathname === adminPath ? AdminApp : App;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootApp />
  </StrictMode>,
);

void initializePwaUpdates();
