import { describe, expect, it, vi } from "vitest";

import {
  PWA_UPDATE_CHECK_INTERVAL_MS,
  watchForPwaUpdates,
} from "./pwa-updates.js";

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

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(update: () => Promise<unknown>) {
  const windowTarget = new FakeEventTarget();
  const documentTarget = new FakeDocumentTarget();
  let now = 1_000;
  const stop = watchForPwaUpdates(
    { update: update as ServiceWorkerRegistration["update"] },
    {
      windowTarget: windowTarget as unknown as Window,
      documentTarget: documentTarget as unknown as Document,
      now: () => now,
      minimumIntervalMs: PWA_UPDATE_CHECK_INTERVAL_MS,
    },
  );
  return {
    documentTarget,
    stop,
    windowTarget,
    advanceBy(milliseconds: number) {
      now += milliseconds;
    },
  };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("PWA update checks", () => {
  it("checks on focus and visible resume while throttling paired events", async () => {
    const update = vi.fn(async () => undefined);
    const harness = createHarness(update);

    harness.windowTarget.dispatch("focus");
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(1);

    harness.documentTarget.dispatch("visibilitychange");
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(1);

    harness.advanceBy(PWA_UPDATE_CHECK_INTERVAL_MS);
    harness.documentTarget.dispatch("visibilitychange");
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("does not check while the document is hidden", async () => {
    const update = vi.fn(async () => undefined);
    const harness = createHarness(update);
    harness.documentTarget.hidden = true;

    harness.windowTarget.dispatch("focus");
    harness.documentTarget.dispatch("visibilitychange");
    await flushPromises();

    expect(update).not.toHaveBeenCalled();
  });

  it("keeps only one update request in flight", async () => {
    const pending = deferred<unknown>();
    const update = vi.fn(() => pending.promise);
    const harness = createHarness(update);

    harness.windowTarget.dispatch("focus");
    await flushPromises();
    harness.advanceBy(PWA_UPDATE_CHECK_INTERVAL_MS);
    harness.documentTarget.dispatch("visibilitychange");
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(1);

    pending.resolve(undefined);
    await flushPromises();
    harness.windowTarget.dispatch("focus");
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("recovers from a failed check and removes listeners when stopped", async () => {
    const update = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const harness = createHarness(update);

    harness.windowTarget.dispatch("focus");
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(1);

    harness.advanceBy(PWA_UPDATE_CHECK_INTERVAL_MS);
    harness.documentTarget.dispatch("visibilitychange");
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(2);

    harness.stop();
    harness.advanceBy(PWA_UPDATE_CHECK_INTERVAL_MS);
    harness.windowTarget.dispatch("focus");
    harness.documentTarget.dispatch("visibilitychange");
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(2);
  });
});
