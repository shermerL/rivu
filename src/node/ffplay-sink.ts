import { runFFplay, type PlayerResult } from "./ffplay-process.js";

export const MAX_JPEG_BYTES = 512 * 1024;
export const MAX_JPEG_FRAMES = 30;

export async function playJpeg(
  jpeg: Buffer,
  signal: AbortSignal,
): Promise<PlayerResult> {
  return playJpegSequence([jpeg], signal);
}

export async function playJpegSequence(
  frames: readonly Buffer[],
  signal: AbortSignal,
): Promise<PlayerResult> {
  if (signal.aborted) {
    return { kind: "cancelled" };
  }

  if (frames.length === 0 || frames.length > MAX_JPEG_FRAMES) {
    return {
      kind: "failed",
      error: new Error(
        `Expected 1 to ${MAX_JPEG_FRAMES} JPEG frames`,
      ),
      diagnostic: "",
    };
  }

  for (const jpeg of frames) {
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
  }

  return runFFplay(frames, { signal });
}
