import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs, type CliAction } from "../src/cli/args.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const entryPath = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

const cases: { name: string; args: string[]; expected: CliAction }[] = [
  { name: "no arguments", args: [], expected: { kind: "help" } },
  { name: "help", args: ["--help"], expected: { kind: "help" } },
  { name: "version", args: ["--version"], expected: { kind: "version" } },
  { name: "missing image path", args: ["play-image"], expected: { kind: "error", message: "Expected: play-image <path>" } },
  { name: "empty image path", args: ["play-image", ""], expected: { kind: "error", message: "Expected: play-image <path>" } },
  { name: "extra image argument", args: ["play-image", "frame.jpg", "extra"], expected: { kind: "error", message: "Expected: play-image <path>" } },
  {
    name: "unknown word",
    args: ["hello"],
    expected: { kind: "error", message: 'Unknown argument: "hello"' },
  },
  {
    name: "unknown option",
    args: ["--unknown"],
    expected: { kind: "error", message: 'Unknown argument: "--unknown"' },
  },
  {
    name: "unsupported alias",
    args: ["-h"],
    expected: { kind: "error", message: 'Unknown argument: "-h"' },
  },
  {
    name: "empty argument",
    args: [""],
    expected: { kind: "error", message: 'Unknown argument: ""' },
  },
  {
    name: "extra argument after help",
    args: ["--help", "extra"],
    expected: { kind: "error", message: 'Unexpected extra argument: "extra"' },
  },
  {
    name: "extra argument after version",
    args: ["--version", "extra"],
    expected: { kind: "error", message: 'Unexpected extra argument: "extra"' },
  },
  {
    name: "combined options",
    args: ["--help", "--version"],
    expected: { kind: "error", message: 'Unexpected extra argument: "--version"' },
  },
  {
    name: "reversed combined options",
    args: ["--version", "--help"],
    expected: { kind: "error", message: 'Unexpected extra argument: "--help"' },
  },
  {
    name: "line break in argument",
    args: ["bad\nargument"],
    expected: { kind: "error", message: 'Unknown argument: "bad\\nargument"' },
  },
];

for (const { name, args, expected } of cases) {
  test(`parseArgs: ${name}`, () => {
    const input = [...args];
    Object.freeze(input);
    assert.deepEqual(parseArgs(input), expected);
    assert.deepEqual(input, args);
  });

  test(`CLI: ${name}`, () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", entryPath, ...args],
      { cwd: projectRoot, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);

    if (expected.kind === "error") {
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr.trim().split("\n").length, 1);
      const record = JSON.parse(result.stderr);
      assert.equal(new Date(record.time).toISOString(), record.time);
      assert.deepEqual(record, {
        time: record.time,
        level: "error",
        scope: "cli",
        event: "invalid_arguments",
        fields: { message: expected.message },
      });
    } else {
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      if (expected.kind === "version") {
        assert.equal(result.stdout, "0.0.0\n");
      } else {
        assert.match(result.stdout, /^Rivu - media transport playground\n/);
        assert.match(result.stdout, /Usage: rivu \[--help \| --version\]/);
        assert.match(result.stdout, /--help\s+Show this help message/);
        assert.match(result.stdout, /--version\s+Show version/);
      }
    }
  });
}

for (const path of ["frame.jpg", "folder with spaces/frame.jpg", "-frame.jpg"]) {
  test(`parseArgs: image path ${JSON.stringify(path)}`, () => {
    assert.deepEqual(parseArgs(["play-image", path]), { kind: "play-image", path });
  });
}
