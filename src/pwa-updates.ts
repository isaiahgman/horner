export const PWA_UPDATE_CHECK_INTERVAL_MS = 30_000;

type UpdatableRegistration = Pick<ServiceWorkerRegistration, "update">;

interface UpdateCheckEnvironment {
  readonly windowTarget: Pick<Window, "addEventListener" | "removeEventListener">;
  readonly documentTarget: Pick<Document, "addEventListener" | "removeEventListener" | "hidden">;
  readonly now: () => number;
  readonly minimumIntervalMs: number;
}

function browserEnvironment(): UpdateCheckEnvironment {
  return {
    windowTarget: window,
    documentTarget: document,
    now: () => performance.now(),
    minimumIntervalMs: PWA_UPDATE_CHECK_INTERVAL_MS,
  };
}

export function watchForPwaUpdates(
  registration: UpdatableRegistration,
  environment: UpdateCheckEnvironment = browserEnvironment(),
): () => void {
  let stopped = false;
  let updateInFlight = false;
  let lastUpdateStartedAt = Number.NEGATIVE_INFINITY;

  const checkForUpdate = () => {
    if (stopped || updateInFlight || environment.documentTarget.hidden) return;

    const startedAt = environment.now();
    if (startedAt - lastUpdateStartedAt < environment.minimumIntervalMs) return;

    lastUpdateStartedAt = startedAt;
    updateInFlight = true;
    void Promise.resolve()
      .then(() => registration.update())
      .catch(() => undefined)
      .finally(() => {
        updateInFlight = false;
      });
  };

  const onVisibilityChange = () => {
    if (!environment.documentTarget.hidden) checkForUpdate();
  };

  environment.windowTarget.addEventListener("focus", checkForUpdate);
  environment.documentTarget.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    stopped = true;
    environment.windowTarget.removeEventListener("focus", checkForUpdate);
    environment.documentTarget.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
