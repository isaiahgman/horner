import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import { App } from "./App.js";
import { watchForPwaUpdates } from "./pwa-updates.js";
import "./styles.css";

let stopUpdateChecks: () => void = () => undefined;

registerSW({
  immediate: true,
  onRegisteredSW: (_serviceWorkerUrl, registration) => {
    stopUpdateChecks();
    if (registration) stopUpdateChecks = watchForPwaUpdates(registration);
  },
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => stopUpdateChecks());
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
