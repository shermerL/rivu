import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const built = fileURLToPath(new URL("../dist/cli/main.js", import.meta.url));
const loader = import.meta.resolve("tsx");
const cases = [[], ["--help"], ["--version"], ["hello"], ["--unknown"], ["-h"], [""],
  ["--help", "extra"], ["--version", "extra"], ["--help", "--version"], ["--version", "--help"], ["bad\nargument"], ["play-image"], ["play-image", ""], ["play-image", "frame.jpg", "extra"],
  ["play-jpeg"], ["play-jpeg", ""], ["play-jpeg", "frame.jpg", "extra"],
  ["play-jpegs"], ["play-jpegs", ""], ["play-jpegs", "first.jpg", ""]];

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

const playback = spawnSync(process.execPath, ["--import", loader, "--test",
  fileURLToPath(new URL("../tests/play-image.test.ts", import.meta.url))], {
  cwd: tmpdir(), env: { ...process.env, RIVU_TEST_BUILT: "1" },
  encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024,
});
process.stdout.write(playback.stdout ?? "");
process.stderr.write(playback.stderr ?? "");
assert.equal(playback.error, undefined);
assert.equal(playback.signal, null);
assert.equal(playback.status, 0, "Built image playback integration checks failed");
