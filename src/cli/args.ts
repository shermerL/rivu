export type CliAction =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "play-image"; path: string }
  | { kind: "error"; message: string };

export function parseArgs(args: string[]): CliAction {
  if (args[0] === "play-image") {
    if (args.length !== 2 || !args[1]) {
      return { kind: "error", message: "Expected: play-image <path>" };
    }
    return { kind: "play-image", path: args[1] };
  }
  if (args.length === 0) {
    return { kind: "help" };
  }

  if (args.length > 1) {
    return {
      kind: "error",
      message: `Unexpected extra argument: ${JSON.stringify(args[1])}`,
    };
  }

  switch (args[0]) {
    case "--help":
      return { kind: "help" };
    case "--version":
      return { kind: "version" };
    default:
      return {
        kind: "error",
        message: `Unknown argument: ${JSON.stringify(args[0])}`,
      };
  }
}
