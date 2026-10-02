import { fork } from "node:child_process";

export async function startIsolatedWebKitPreview(): Promise<{
  origin: string;
  stop: () => Promise<void>;
}> {
  const child = fork(new URL("../scripts/preview-webkit.mjs", import.meta.url), ["0"], {
    silent: true,
  });
  let errors = "";
  child.stderr?.on("data", (data: Buffer) => { errors += data.toString(); });

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
  };

  try {
    const origin = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Local HTTPS preview did not start.")), 15_000);
      const cleanup = (): void => {
        clearTimeout(timeout);
        child.off("error", onError);
        child.off("exit", onExit);
        child.off("message", onMessage);
      };
      const onError = (error: Error): void => { cleanup(); reject(error); };
      const onExit = (): void => {
        cleanup();
        reject(new Error(`Local HTTPS preview exited before readiness: ${errors}`));
      };
      const onMessage = (message: unknown): void => {
        if (typeof message === "object" && message !== null && "origin" in message
          && typeof message.origin === "string" && /^https:\/\/127\.0\.0\.1:\d+$/.test(message.origin)) {
          cleanup();
          resolve(message.origin);
        }
      };
      child.once("error", onError);
      child.once("exit", onExit);
      child.on("message", onMessage);
    });
    return { origin, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
