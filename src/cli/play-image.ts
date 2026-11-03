import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

import { runFFplay, type PlayerResult } from "../node/ffplay-process.js";
import { playJpeg, MAX_JPEG_BYTES } from "../node/ffplay-sink.js";
import { createLogger, errorFields } from "../node/logger.js";

export async function playImage(
  input: string,
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
    const path = resolve(input);
    const info = await stat(path);

    if (!info.isFile()) {
      throw new Error("Image path must be a regular file");
    }

    await access(path, constants.R_OK);

    let result: PlayerResult;

    if (mode === "pipe") {
      if (info.size > MAX_JPEG_BYTES) {
        throw new Error("JPEG exceeds 512 KiB");
      }

      const jpeg = await readFile(path, {
        signal: controller.signal,
      });

      logger.info("loaded", {
        path,
        bytes: jpeg.length,
      });

      result = await playJpeg(jpeg, controller.signal);
    } else {
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
