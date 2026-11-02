import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const built = fileURLToPath(new URL("../dist/cli/main.js", import.meta.url));
const loader = import.meta.resolve("tsx");
const cases = [[], ["--help"], ["--version"], ["hello"], ["--unknown"], ["-h"], [""],
  ["--help", "extra"], ["--version", "extra"], ["--help", "--version"], ["--version", "--help"], ["bad\nargument"]];

function run(entry, args) {
  const result = spawnSync(process.execPath, [...entry, ...args], {
    cwd: tmpdir(), encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  let error = null;
  if (result.stderr) {
    assert.equal(result.stderr.trim().split("\n").length, 1);
    const record = JSON.parse(result.stderr);
    assert.equal(new Date(record.time).toISOString(), record.time);
    const { time, ...stable } = record;
    error = stable;
  }
  return { code: result.status, stdout: result.stdout, error };
}

for (const args of cases) {
  assert.deepEqual(run([built], args), run(["--import", loader, source], args), JSON.stringify(args));
}
console.log(`Built CLI matches source for ${cases.length} cases (launched outside the project directory).`);
