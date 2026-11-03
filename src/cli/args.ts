export type CliAction =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "play-image"; path: string }
  | { kind: "play-jpeg"; path: string }
  | { kind: "error"; message: string };

export function parseArgs(args: string[]): CliAction {
  if (args[0] === "play-image" || args[0] === "play-jpeg") {
    if (args.length !== 2 || !args[1]) {
      return {
        kind: "error",
        message: `Expected: ${args[0]} <path>`,
      };
    }

    return {
      kind: args[0],
      path: args[1],
    };
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
