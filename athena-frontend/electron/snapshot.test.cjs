const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  MAX_SNAPSHOT_BYTES,
  saveSnapshot,
} = require("./snapshot.cjs");

function jpegBytes(size = 5) {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff]);
  bytes[bytes.length - 2] = 0xff;
  bytes[bytes.length - 1] = 0xd9;
  return bytes.buffer;
}

test("rejects non-ArrayBuffer snapshot payloads", async () => {
  await assert.rejects(
    () => saveSnapshot({ getPath: () => os.tmpdir() }, "not-image"),
    TypeError,
  );
});

test("rejects snapshots larger than the configured limit", async () => {
  const payload = new ArrayBuffer(MAX_SNAPSHOT_BYTES + 1);

  await assert.rejects(
    () => saveSnapshot({ getPath: () => os.tmpdir() }, payload),
    /size limit/,
  );
});

test("creates the app snapshot directory and writes a unique jpeg", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "athena-snapshot-test-"));
  const filePath = await saveSnapshot({ getPath: () => root }, jpegBytes());

  assert.equal(path.dirname(filePath), path.join(root, "snapshots"));
  assert.match(path.basename(filePath), /^snapshot-\d+-[0-9a-f-]+\.jpg$/);
  assert.deepEqual(fs.readFileSync(filePath), Buffer.from(jpegBytes()));

  fs.rmSync(root, { recursive: true, force: true });
});
