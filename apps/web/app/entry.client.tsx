// One recovery boundary for obsolete public documents, including route metadata in <Meta>.
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { createRenderErrorHandler } from "./lib/render-recovery";

// Capture once before hydration; this belongs to the document, not later navigation responses.
const documentRelease = document.querySelector('meta[name="tongxing-release"]')?.getAttribute("content") ?? null;
const onError = createRenderErrorHandler(documentRelease);

if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
  const register = () => navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  // This module is an async module script: `load` may already have fired when it runs,
  // so a load listener registered then never fires. Register immediately if complete.
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
    { onCaughtError: onError },
  );
});
