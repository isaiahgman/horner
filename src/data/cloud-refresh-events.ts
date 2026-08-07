interface CloudRefreshEventOptions {
  readonly documentTarget: Pick<Document, "addEventListener" | "hidden" | "removeEventListener">;
  readonly refreshCloud: () => void;
  readonly refreshLocal: () => void;
  readonly shouldRefreshCloud: () => boolean;
  readonly windowTarget: Pick<Window, "addEventListener" | "removeEventListener">;
}

export function watchForCloudRefreshEvents({
  documentTarget,
  refreshCloud,
  refreshLocal,
  shouldRefreshCloud,
  windowTarget,
}: CloudRefreshEventOptions): () => void {
  const refresh = () => {
    if (documentTarget.hidden) return;
    if (shouldRefreshCloud()) refreshCloud();
    else refreshLocal();
  };
  const onVisibilityChange = () => {
    if (!documentTarget.hidden) refresh();
  };

  windowTarget.addEventListener("focus", refresh);
  documentTarget.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    windowTarget.removeEventListener("focus", refresh);
    documentTarget.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
