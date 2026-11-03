import { runFFplay, type PlayerResult } from "./ffplay-process.js";

export const MAX_JPEG_BYTES = 512 * 1024;

export async function playJpeg(
  jpeg: Buffer,
  signal: AbortSignal,
): Promise<PlayerResult> {
  if (signal.aborted) {
    return { kind: "cancelled" };
  }

  if (
    jpeg.length < 2 ||
    jpeg.length > MAX_JPEG_BYTES ||
    jpeg[0] !== 0xff ||
    jpeg[1] !== 0xd8
  ) {
    return {
      kind: "failed",
      error: new Error("Expected JPEG bytes, at most 512 KiB"),
      diagnostic: "",
    };
  }

  return runFFplay(jpeg, { signal });
}
