import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

import { runFFplay, type PlayerResult } from "../node/ffplay-process.js";
import { createLogger, errorFields } from "../node/logger.js";
import {
  playJpegSequence,
  MAX_JPEG_BYTES,
  MAX_JPEG_FRAMES,
} from "../node/ffplay-sink.js";

export async function playImage(
  input: string | readonly string[],
  mode: "path" | "pipe" = "path",
): Promise<number> {
  const logger = createLogger("player");
  const controller = new AbortController();
  let interrupted: "SIGINT" | "SIGTERM" | undefined;
  const interrupt = (signal: "SIGINT" | "SIGTERM") => {
    interrupted ??= signal;
    controller.abort();
  };
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    let result: PlayerResult;

    if (mode === "pipe") {
      const inputs = typeof input === "string" ? [input] : input;
      if (inputs.length === 0 || inputs.length > MAX_JPEG_FRAMES) {
        throw new Error(`Expected 1 to ${MAX_JPEG_FRAMES} JPEG paths`);
      }

      const frames: Buffer[] = [];
      for (const item of inputs) {
        const path = resolve(item);
        const info = await stat(path);
        if (!info.isFile()) {
          throw new Error("Image path must be a regular file");
        }
        await access(path, constants.R_OK);
        if (info.size > MAX_JPEG_BYTES) {
          throw new Error("JPEG exceeds 512 KiB");
        }

        const jpeg = await readFile(path, { signal: controller.signal });
        if (jpeg.length > MAX_JPEG_BYTES) {
          throw new Error("JPEG exceeds 512 KiB");
        }
        logger.info("loaded", { path, bytes: jpeg.length });
        frames.push(jpeg);
      }

      result = await playJpegSequence(frames, controller.signal);
    } else {
      if (typeof input !== "string") {
        throw new Error("Path playback expects one image path");
      }
      const path = resolve(input);
      const info = await stat(path);
      if (!info.isFile()) {
        throw new Error("Image path must be a regular file");
      }
      await access(path, constants.R_OK);
      result = await runFFplay(path, {
        signal: controller.signal,
        onSpawn: () => {
          logger.info("started", { path });
        },
      });
    }
    if (result.kind === "cancelled") {
      logger.info("cancelled", { signal: interrupted ?? "SIGINT" });
      return interrupted === "SIGTERM" ? 143 : 130;
    }
    if (result.kind === "failed") {
      logger.error("failed", { ...errorFields(result.error), diagnostic: result.diagnostic });
      return 1;
    }
    if (result.code !== 0 || result.signal !== null) {
      logger.error("failed", { code: result.code, signal: result.signal });
      return 1;
    }
    logger.info("closed");
    return 0;
  } catch (error) {
    if (interrupted) {
      logger.info("cancelled", { signal: interrupted });
      return interrupted === "SIGTERM" ? 143 : 130;
    }
    logger.error("failed", errorFields(error instanceof Error ? error : new Error(String(error))));
    return 1;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
}
