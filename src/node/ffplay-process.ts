import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { writeBuffer } from "./write-buffer.js";

type SpawnPlayer = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
type PlayerOptions = {
  signal: AbortSignal;
  spawnPlayer?: SpawnPlayer;
  onSpawn?: () => void;
};

export type PlayerResult =
  | { kind: "closed"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "failed"; error: Error; diagnostic: string }
  | { kind: "cancelled" };

// Resolves only after close, including when spawn fails or cancellation escalates.
export function runFFplay(input: string | Buffer, options: PlayerOptions): Promise<PlayerResult> {
  if (options.signal.aborted) return Promise.resolve({ kind: "cancelled" });

  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      const inputArgs = typeof input === "string"
        ? ["-f", "image2", "-pattern_type", "none", "-i", input]
        : [
            "-f", "image2pipe",
            "-framerate", "10",
            "-vcodec", "mjpeg",
            "-i", "pipe:0",
          ];

      child = (options.spawnPlayer ?? spawn)(
        "ffplay",
        [
          "-hide_banner",
          "-loglevel", "level+error",
          "-nostats",
          "-an",
          "-sn",
          ...inputArgs,
        ],
        {
          shell: false,
          stdio: [
            typeof input === "string" ? "ignore" : "pipe",
            "ignore",
            "pipe",
          ],
        },
      );
    } catch (error) {
      resolve({ kind: "failed", error: error instanceof Error ? error : new Error(String(error)), diagnostic: "" });
      return;
    }

    let error: Error | undefined;
    let diagnostic = Buffer.alloc(0);
    let stopReason: "cancelled" | "diagnostic" | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const running = () => child.exitCode === null && child.signalCode === null;

    function stop(reason: "cancelled" | "diagnostic") {
      if (stopReason) return;
      stopReason = reason;
      child.stdin?.destroy();
      if (!running() || child.pid === undefined) return;
      child.kill("SIGTERM");
      timer = setTimeout(() => {
        if (running()) child.kill("SIGKILL");
      }, 1000);
      timer.unref();
    }

    async function feedJpeg(jpeg: Buffer): Promise<void> {
      const stdin = child.stdin;

      if (!stdin) {
        throw new Error("FFplay stdin is unavailable");
      }

      await writeBuffer(stdin, jpeg, options.signal);

      if (!options.signal.aborted && !stdin.destroyed) {
        stdin.end();
      }
    }

    const abort = () => stop("cancelled");
    child.on("error", cause => { error ??= cause; });
    child.stdin?.on("error", cause => {
      error ??= cause;
      stop("diagnostic");
    });

    child.once("spawn", () => {
      options.onSpawn?.();

      if (Buffer.isBuffer(input) && !options.signal.aborted) {
        void feedJpeg(input).catch(cause => {
          error ??= cause instanceof Error
            ? cause
            : new Error(String(cause));

          stop("diagnostic");
        });
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      // FFplay may report a decoding failure while eventually exiting with code 0.
      // Keep only the last 8 KiB of error-level output and stop a failed player.
      const output = Buffer.concat([diagnostic, chunk]);
      diagnostic = Buffer.from(output.subarray(-8192));
      // Native window systems may also write to stderr; only FFmpeg severity
      // markers indicate a decoding/player failure, even across chunk boundaries.
      if (/(?:^|\n)(?:\[[^\]\r\n]*\]\s*)*\[(?:error|fatal|panic)\]/.test(output.toString("utf8"))) {
        stop("diagnostic");
      }
    });
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      if (stopReason === "cancelled") {
        resolve({ kind: "cancelled" });
      } else if (error || stopReason === "diagnostic") {
        resolve({ kind: "failed", error: error ?? new Error("FFplay reported an error"), diagnostic: diagnostic.toString("utf8") });
      } else {
        resolve({ kind: "closed", code, signal });
      }
    });
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
  });
}
