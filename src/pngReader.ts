import * as fs from 'fs';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function readPngTextChunks(buffer: Buffer): Map<string, string> {
  const result = new Map<string, string>();

  if (buffer.length < 8 || buffer.subarray(0, 8).compare(PNG_SIGNATURE) !== 0) {
    throw new Error('Not a valid PNG file');
  }

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);

    // Stop at image data — metadata chunks come before IDAT
    if (type === 'IDAT' || type === 'IEND') {
      break;
    }

    if (type === 'tEXt' && offset + 8 + length <= buffer.length) {
      const data = buffer.subarray(offset + 8, offset + 8 + length);
      const nullIdx = data.indexOf(0);
      if (nullIdx >= 0) {
        const key = data.subarray(0, nullIdx).toString('latin1');
        const value = data.subarray(nullIdx + 1).toString('utf-8');
        result.set(key, value);
      }
    }

    // Move past: 4 (length) + 4 (type) + length (data) + 4 (CRC)
    offset += 12 + length;
  }

  return result;
}

export async function readPngMetadata(filePath: string): Promise<Map<string, string>> {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    // Try reading the first 64KB — sufficient for most metadata
    const initialSize = 65536;
    const buf = Buffer.alloc(initialSize);
    const { bytesRead } = await fd.read(buf, 0, initialSize, 0);
    const result = readPngTextChunks(buf.subarray(0, bytesRead));

    // If we read the full buffer and found no IDAT, metadata may be truncated.
    // Re-read with a larger buffer (up to 2MB) to capture large ComfyUI workflows.
    if (bytesRead === initialSize && result.size === 0) {
      const largeSize = 2 * 1024 * 1024;
      const largeBuf = Buffer.alloc(largeSize);
      const { bytesRead: largeRead } = await fd.read(largeBuf, 0, largeSize, 0);
      return readPngTextChunks(largeBuf.subarray(0, largeRead));
    }

    return result;
  } finally {
    await fd.close();
  }
}
