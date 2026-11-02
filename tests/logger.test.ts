import assert from "node:assert/strict";
import test from "node:test";
import { createLogger, errorFields, type LogFields, type LogLevel } from "../src/node/logger.js";

const instant = new Date("2026-11-02T00:00:00.000Z");
const levels: LogLevel[] = ["debug", "info", "warn", "error"];

for (const [index, level] of levels.entries()) {
  test(`logger filters below ${level}`, () => {
    const lines: string[] = [];
    const logger = createLogger("test", { level, now: () => instant, write: line => { lines.push(line); } });
    for (const [position, method] of levels.entries()) {
      assert.equal(logger[method]("event"), position >= index);
    }
    assert.deepEqual(lines.map(line => JSON.parse(line).level), levels.slice(index));
  });
}

test("default level is info and filtered logs do not read the clock or write", () => {
  const logger = createLogger("test", {
    now: () => { assert.fail("clock should not run"); },
    write: () => { assert.fail("writer should not run"); },
  });
  assert.equal(logger.debug("packet"), false);
});

test("fields stay nested and newlines remain within one JSON record", () => {
  const lines: string[] = [];
  const logger = createLogger("player", { now: () => instant, write: line => { lines.push(line); } });
  const fields = { time: "override", level: "override", scope: "override", event: "override",
    message: 'line one\nline two "quoted"', count: 2, ready: true, missing: null };
  assert.equal(logger.info("start\nimage", fields), true);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0]!.includes("\n"));
  assert.deepEqual(JSON.parse(lines[0]!), {
    time: instant.toISOString(), level: "info", scope: "player", event: "start\nimage", fields,
  });
});

test("invalid runtime values cannot break JSON or invoke toJSON", () => {
  const lines: string[] = [];
  const logger = createLogger("test", { write: line => { lines.push(line); } });
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  const fields = { okay: 1, nan: NaN, infinity: Infinity, big: 1n, circular,
    object: { toJSON: () => { assert.fail("must not serialize nested objects"); } }, missing: undefined };
  assert.equal(logger.error("failed", fields as unknown as LogFields), true);
  assert.deepEqual(JSON.parse(lines[0]!).fields, { okay: 1 });
});

test("writer or clock failures do not escape diagnostic calls", () => {
  assert.equal(createLogger("test", { write: () => { throw new Error("sink closed"); } }).error("failure"), false);
  assert.equal(createLogger("test", { now: () => new Date(NaN) }).error("failure"), false);
});

test("Error extraction includes name/message/scalar code, not arbitrary attached data", () => {
  const error = Object.assign(new Error("missing player"), { code: "ENOENT", token: "private", cause: {} });
  assert.deepEqual(errorFields(error), { name: "Error", message: "missing player", code: "ENOENT" });
  assert.deepEqual(errorFields(new TypeError("bad path")), { name: "TypeError", message: "bad path" });
});
