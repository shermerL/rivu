import { parseArgs } from "./args.js";
import { createLogger } from "../node/logger.js";

const HELP = `Rivu - media transport playground
Usage: rivu [--help | --version]

Options:
  --help     Show this help message
  --version  Show version`;

const action = parseArgs(process.argv.slice(2));

switch (action.kind) {
  case "help":
    console.log(HELP);
    break;
  case "version":
    console.log("0.0.0");
    break;
  case "error":
    process.exitCode = 1;
    createLogger("cli").error("invalid_arguments", { message: action.message });
    break;
}
