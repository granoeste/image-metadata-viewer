import * as fs from 'fs';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function readPngTextChunks(buffer: Buffer): Map<string, string> {
  return scanPngTextChunks(buffer).chunks;
}

/**
 * tEXt チャンクを走査する。reachedImageData は IDAT/IEND まで到達できたか
 * （false の場合、バッファ不足でメタデータが途中で切れている可能性がある）。
 */
function scanPngTextChunks(buffer: Buffer): { chunks: Map<string, string>; reachedImageData: boolean } {
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
      return { chunks: result, reachedImageData: true };
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

  return { chunks: result, reachedImageData: false };
}

export async function readPngMetadata(filePath: string): Promise<Map<string, string>> {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    // Try reading the first 64KB — sufficient for most metadata
    const initialSize = 65536;
    const buf = Buffer.alloc(initialSize);
    const { bytesRead } = await fd.read(buf, 0, initialSize, 0);
    const { chunks, reachedImageData } = scanPngTextChunks(buf.subarray(0, bytesRead));

    // If we read the full buffer and didn't reach IDAT, metadata may be truncated
    // (e.g. `prompt` fits in 64KB but a large `workflow` chunk does not).
    // Re-read with a larger buffer (up to 8MB) to capture large ComfyUI workflows.
    if (bytesRead === initialSize && !reachedImageData) {
      const largeSize = 8 * 1024 * 1024;
      const largeBuf = Buffer.alloc(largeSize);
      const { bytesRead: largeRead } = await fd.read(largeBuf, 0, largeSize, 0);
      return readPngTextChunks(largeBuf.subarray(0, largeRead));
    }

    return chunks;
  } finally {
    await fd.close();
  }
}

/**
 * PNG の IHDR チャンクから画像サイズを読み取る。
 */
export function readPngSizeFromBuffer(buffer: Buffer): { width: number; height: number } | undefined {
  // signature (8) + length (4) + "IHDR" (4) + width (4) + height (4)
  if (buffer.length < 24 || buffer.subarray(0, 8).compare(PNG_SIGNATURE) !== 0) {
    return undefined;
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') {
    return undefined;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export async function readPngSize(filePath: string): Promise<{ width: number; height: number } | undefined> {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(24);
    const { bytesRead } = await fd.read(buf, 0, 24, 0);
    return readPngSizeFromBuffer(buf.subarray(0, bytesRead));
  } finally {
    await fd.close();
  }
}
