import type { Writable } from "node:stream";

export function writeBuffer(
  writable: Writable,
  bytes: Buffer,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    function onDrain(): void {
      finish();
    }

    function onError(error: Error): void {
      finish(error);
    }
    function onClose(): void {
      finish(new Error("Writable closed before drain"));
    }

    function onAbort(): void {
      const error = new Error("Write aborted");
      error.name = "AbortError";

      finish(error);
    }

    function cleanup(): void {
      writable.off("drain", onDrain);
      writable.off("error", onError);
      writable.off("close", onClose);

      signal.removeEventListener("abort", onAbort);
    }

    function finish(error?: Error): void {
      if (settled) {
        return;
      }

      settled = true;

      cleanup();

      if (error !== undefined) {
        reject(error);
      } else {
        resolve();
      }
    }


    if (signal.aborted) {
      onAbort();
      return;
    }


    if (
      writable.destroyed ||
      writable.writableEnded ||
      !writable.writable
    ) {
      finish(new Error("Writable is not available"));
      return;
    }

    writable.once("drain", onDrain);
    writable.once("error", onError);
    writable.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      const canContinue = writable.write(bytes);

      if (canContinue) {
        finish();
      }


    } catch (cause) {
      finish(
        cause instanceof Error
          ? cause
          : new Error(String(cause)),
      );
    }


  });
}
