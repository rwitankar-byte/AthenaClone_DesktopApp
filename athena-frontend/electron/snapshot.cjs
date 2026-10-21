const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

function isImageBuffer(buffer) {
  const isJpeg = buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  return isJpeg || isPng;
}

async function saveSnapshot(app, payload) {
  if (!(payload instanceof ArrayBuffer)) {
    throw new TypeError("Snapshot payload must be an ArrayBuffer");
  }

  const buffer = Buffer.from(payload);
  if (buffer.length === 0 || buffer.length > MAX_SNAPSHOT_BYTES) {
    throw new RangeError(`Snapshot exceeds the ${MAX_SNAPSHOT_BYTES}-byte size limit`);
  }
  if (!isImageBuffer(buffer)) {
    throw new TypeError("Snapshot payload is not a supported image");
  }

  const directory = path.join(app.getPath("userData"), "snapshots");
  await fs.mkdir(directory, { recursive: true });

  const filename = `snapshot-${Date.now()}-${crypto.randomUUID()}.jpg`;
  const filePath = path.join(directory, filename);
  await fs.writeFile(filePath, buffer, { flag: "wx" });
  return filePath;
}

module.exports = { MAX_SNAPSHOT_BYTES, saveSnapshot };
