import { describe, expect, it, vi } from "vitest";

import { watchForCloudRefreshEvents } from "./cloud-refresh-events.js";

type Listener = () => void;

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

class FakeDocumentTarget extends FakeEventTarget {
  hidden = false;
}

function createHarness(shouldRefreshCloud: () => boolean) {
  const windowTarget = new FakeEventTarget();
  const documentTarget = new FakeDocumentTarget();
  const refreshCloud = vi.fn();
  const refreshLocal = vi.fn();
  const stop = watchForCloudRefreshEvents({
    documentTarget: documentTarget as unknown as Document,
    refreshCloud,
    refreshLocal,
    shouldRefreshCloud,
    windowTarget: windowTarget as unknown as Window,
  });
  return { documentTarget, refreshCloud, refreshLocal, stop, windowTarget };
}

describe("cloud refresh events", () => {
  it("refreshes cloud when a signed-in online app regains focus", () => {
    const harness = createHarness(() => true);

    harness.windowTarget.dispatch("focus");

    expect(harness.refreshCloud).toHaveBeenCalledOnce();
    expect(harness.refreshLocal).not.toHaveBeenCalled();
  });

  it("refreshes only local state when cloud refresh is unavailable", () => {
    const harness = createHarness(() => false);

    harness.windowTarget.dispatch("focus");
    harness.documentTarget.dispatch("visibilitychange");

    expect(harness.refreshLocal).toHaveBeenCalledTimes(2);
    expect(harness.refreshCloud).not.toHaveBeenCalled();
  });

  it("ignores hidden and stopped apps", () => {
    const harness = createHarness(() => true);
    harness.documentTarget.hidden = true;

    harness.windowTarget.dispatch("focus");
    harness.documentTarget.dispatch("visibilitychange");
    harness.stop();
    harness.documentTarget.hidden = false;
    harness.windowTarget.dispatch("focus");

    expect(harness.refreshCloud).not.toHaveBeenCalled();
    expect(harness.refreshLocal).not.toHaveBeenCalled();
  });
});
