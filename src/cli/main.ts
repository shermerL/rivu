import { parseArgs } from "./args.js";
import { createLogger } from "../node/logger.js";
import { playImage } from "./play-image.js";

const HELP = `Rivu - media transport playground
Usage: rivu [--help | --version]
       rivu play-image <path>
       rivu play-jpeg <path>

Commands:
  play-image <path>  Display a local image with FFplay; close the window or press Ctrl+C to stop
  play-jpeg <path>   Read a JPEG and send its bytes to FFplay

Options:
  --help     Show this help message
  --version  Show version`;

const action = parseArgs(process.argv.slice(2));

switch (action.kind) {
  case "play-image":
    process.exitCode = await playImage(action.path);
    break;
  case "play-jpeg":
    process.exitCode = await playImage(action.path, "pipe");
    break;
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
