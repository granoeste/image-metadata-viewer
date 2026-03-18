import * as fs from 'fs';

export interface ExifData {
  [key: string]: string;
}

// Common IFD0 tags
const IFD0_TAGS: Record<number, string> = {
  0x010e: 'ImageDescription',
  0x010f: 'Make',
  0x0110: 'Model',
  0x0112: 'Orientation',
  0x011a: 'XResolution',
  0x011b: 'YResolution',
  0x0131: 'Software',
  0x0132: 'DateTime',
  0x013b: 'Artist',
  0x8298: 'Copyright',
  0x8769: 'ExifIFDPointer',
  0x8825: 'GPSInfoIFDPointer',
  0xa100: 'ImageWidth',  // not standard but sometimes used
  0xa101: 'ImageHeight',
};

// Exif SubIFD tags
const EXIF_TAGS: Record<number, string> = {
  0x829a: 'ExposureTime',
  0x829d: 'FNumber',
  0x8827: 'ISO',
  0x9000: 'ExifVersion',
  0x9003: 'DateTimeOriginal',
  0x9004: 'DateTimeDigitized',
  0x9201: 'ShutterSpeedValue',
  0x9202: 'ApertureValue',
  0x9204: 'ExposureBiasValue',
  0x9207: 'MeteringMode',
  0x9209: 'Flash',
  0x920a: 'FocalLength',
  0xa001: 'ColorSpace',
  0xa002: 'PixelXDimension',
  0xa003: 'PixelYDimension',
  0xa405: 'FocalLengthIn35mmFilm',
  0xa406: 'SceneCaptureType',
  0xa431: 'BodySerialNumber',
  0xa432: 'LensInfo',
  0xa433: 'LensMake',
  0xa434: 'LensModel',
};

// GPS tags
const GPS_TAGS: Record<number, string> = {
  0x0001: 'GPSLatitudeRef',
  0x0002: 'GPSLatitude',
  0x0003: 'GPSLongitudeRef',
  0x0004: 'GPSLongitude',
  0x0005: 'GPSAltitudeRef',
  0x0006: 'GPSAltitude',
};

const METERING_MODES: Record<number, string> = {
  0: 'Unknown', 1: 'Average', 2: 'Center-weighted average',
  3: 'Spot', 4: 'Multi-spot', 5: 'Pattern', 6: 'Partial',
};

const ORIENTATION_MAP: Record<number, string> = {
  1: 'Normal', 2: 'Flipped horizontal', 3: 'Rotated 180°',
  4: 'Flipped vertical', 5: 'Transposed', 6: 'Rotated 90° CW',
  7: 'Transversed', 8: 'Rotated 90° CCW',
};

class BufferReader {
  constructor(
    private readonly buf: Buffer,
    private readonly littleEndian: boolean,
    private readonly tiffOffset: number
  ) {}

  readUint16(offset: number): number {
    return this.littleEndian
      ? this.buf.readUInt16LE(offset)
      : this.buf.readUInt16BE(offset);
  }

  readUint32(offset: number): number {
    return this.littleEndian
      ? this.buf.readUInt32LE(offset)
      : this.buf.readUInt32BE(offset);
  }

  readInt32(offset: number): number {
    return this.littleEndian
      ? this.buf.readInt32LE(offset)
      : this.buf.readInt32BE(offset);
  }

  readRational(offset: number): number {
    const num = this.readUint32(offset);
    const den = this.readUint32(offset + 4);
    return den === 0 ? 0 : num / den;
  }

  readSignedRational(offset: number): number {
    const num = this.readInt32(offset);
    const den = this.readInt32(offset + 4);
    return den === 0 ? 0 : num / den;
  }

  /** Resolve the data offset for a tag entry at `entryOffset`. */
  resolveValue(entryOffset: number, type: number, count: number): number {
    const valueSize = TYPE_SIZES[type] || 1;
    const totalSize = valueSize * count;
    if (totalSize <= 4) {
      return entryOffset + 8; // value is inline
    }
    return this.tiffOffset + this.readUint32(entryOffset + 8);
  }

  readString(offset: number, length: number): string {
    let end = offset + length;
    // Trim null terminator
    while (end > offset && this.buf[end - 1] === 0) { end--; }
    return this.buf.toString('ascii', offset, end).trim();
  }
}

const TYPE_SIZES: Record<number, number> = {
  1: 1,  // BYTE
  2: 1,  // ASCII
  3: 2,  // SHORT
  4: 4,  // LONG
  5: 8,  // RATIONAL
  7: 1,  // UNDEFINED
  9: 4,  // SLONG
  10: 8, // SRATIONAL
};

function readIFD(
  reader: BufferReader,
  ifdOffset: number,
  tagMap: Record<number, string>,
  tiffOffset: number
): { tags: Map<number, { name: string; type: number; count: number; valueOffset: number }>; nextIFD: number } {
  const tags = new Map<number, { name: string; type: number; count: number; valueOffset: number }>();

  const entryCount = reader.readUint16(ifdOffset);
  for (let i = 0; i < entryCount; i++) {
    const entryOffset = ifdOffset + 2 + i * 12;
    const tag = reader.readUint16(entryOffset);
    const type = reader.readUint16(entryOffset + 2);
    const count = reader.readUint32(entryOffset + 4);

    const name = tagMap[tag];
    if (name) {
      const valueOffset = reader.resolveValue(entryOffset, type, count);
      tags.set(tag, { name, type, count, valueOffset });
    }
  }

  const nextIFDOffset = ifdOffset + 2 + entryCount * 12;
  const nextIFD = reader.readUint32(nextIFDOffset);
  return { tags, nextIFD };
}

function formatTagValue(
  reader: BufferReader,
  name: string,
  type: number,
  count: number,
  valueOffset: number
): string {
  switch (type) {
    case 2: // ASCII
      return reader.readString(valueOffset, count);
    case 3: // SHORT
      {
        const val = reader.readUint16(valueOffset);
        if (name === 'Orientation') { return ORIENTATION_MAP[val] || String(val); }
        if (name === 'MeteringMode') { return METERING_MODES[val] || String(val); }
        if (name === 'Flash') { return (val & 1) ? 'Fired' : 'No flash'; }
        if (name === 'ISO') { return String(val); }
        if (name === 'ColorSpace') { return val === 1 ? 'sRGB' : val === 0xffff ? 'Uncalibrated' : String(val); }
        if (name === 'SceneCaptureType') {
          const scenes: Record<number, string> = { 0: 'Standard', 1: 'Landscape', 2: 'Portrait', 3: 'Night' };
          return scenes[val] || String(val);
        }
        return String(val);
      }
    case 4: // LONG
      return String(reader.readUint32(valueOffset));
    case 5: // RATIONAL
      {
        const val = reader.readRational(valueOffset);
        if (name === 'ExposureTime') {
          if (val < 1) {
            const den = Math.round(1 / val);
            return `1/${den}s`;
          }
          return `${val}s`;
        }
        if (name === 'FNumber') { return `f/${val.toFixed(1)}`; }
        if (name === 'FocalLength') { return `${val.toFixed(1)}mm`; }
        if (name === 'GPSAltitude') { return `${val.toFixed(1)}m`; }
        if (name === 'XResolution' || name === 'YResolution') { return String(Math.round(val)); }
        if (name === 'GPSLatitude' || name === 'GPSLongitude') {
          // 3 rationals: degrees, minutes, seconds
          const deg = reader.readRational(valueOffset);
          const min = reader.readRational(valueOffset + 8);
          const sec = reader.readRational(valueOffset + 16);
          return `${deg}° ${min}' ${sec.toFixed(2)}"`;
        }
        return val.toFixed(4);
      }
    case 10: // SRATIONAL
      {
        const val = reader.readSignedRational(valueOffset);
        if (name === 'ExposureBiasValue') { return `${val >= 0 ? '+' : ''}${val.toFixed(1)} EV`; }
        return val.toFixed(4);
      }
    case 7: // UNDEFINED
      if (name === 'ExifVersion') {
        return reader.readString(valueOffset, count);
      }
      return `(${count} bytes)`;
    default:
      return `(type ${type})`;
  }
}

function parseExifFromBuffer(buf: Buffer): ExifData | undefined {
  // Find APP1 marker (0xFFE1)
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) {
    return undefined; // Not a JPEG
  }

  let offset = 2;
  while (offset + 4 < buf.length) {
    if (buf[offset] !== 0xFF) {
      return undefined;
    }
    const marker = buf[offset + 1];
    const segmentLength = buf.readUInt16BE(offset + 2);

    if (marker === 0xE1) {
      // Check for "Exif\0\0"
      const exifHeader = buf.toString('ascii', offset + 4, offset + 8);
      if (exifHeader === 'Exif' && buf[offset + 8] === 0 && buf[offset + 9] === 0) {
        return parseExifTIFF(buf, offset + 10);
      }
    }

    // Skip to next segment (SOS = start of scan, stop looking)
    if (marker === 0xDA) { break; }
    offset += 2 + segmentLength;
  }

  return undefined;
}

function parseExifTIFF(buf: Buffer, tiffOffset: number): ExifData {
  const result: ExifData = {};

  // Byte order
  const byteOrder = buf.toString('ascii', tiffOffset, tiffOffset + 2);
  const littleEndian = byteOrder === 'II'; // 'MM' = big endian

  const reader = new BufferReader(buf, littleEndian, tiffOffset);

  // First IFD offset
  const ifd0Offset = tiffOffset + reader.readUint32(tiffOffset + 4);

  // Read IFD0
  const { tags: ifd0Tags } = readIFD(reader, ifd0Offset, { ...IFD0_TAGS, ...EXIF_TAGS }, tiffOffset);

  for (const [tag, info] of ifd0Tags) {
    if (tag === 0x8769 || tag === 0x8825) { continue; } // skip pointers
    try {
      result[info.name] = formatTagValue(reader, info.name, info.type, info.count, info.valueOffset);
    } catch { /* skip malformed tags */ }
  }

  // Read Exif SubIFD
  const exifPointer = ifd0Tags.get(0x8769);
  if (exifPointer) {
    const exifIFDOffset = tiffOffset + reader.readUint32(exifPointer.valueOffset);
    const { tags: exifTags } = readIFD(reader, exifIFDOffset, EXIF_TAGS, tiffOffset);

    for (const [, info] of exifTags) {
      try {
        result[info.name] = formatTagValue(reader, info.name, info.type, info.count, info.valueOffset);
      } catch { /* skip */ }
    }
  }

  // Read GPS IFD
  const gpsPointer = ifd0Tags.get(0x8825);
  if (gpsPointer) {
    const gpsIFDOffset = tiffOffset + reader.readUint32(gpsPointer.valueOffset);
    const { tags: gpsTags } = readIFD(reader, gpsIFDOffset, GPS_TAGS, tiffOffset);

    for (const [, info] of gpsTags) {
      try {
        result[info.name] = formatTagValue(reader, info.name, info.type, info.count, info.valueOffset);
      } catch { /* skip */ }
    }

    // Format GPS coordinates
    const latRef = result['GPSLatitudeRef'];
    const lat = result['GPSLatitude'];
    const lonRef = result['GPSLongitudeRef'];
    const lon = result['GPSLongitude'];
    if (lat && lon) {
      result['GPS'] = `${lat} ${latRef || ''}, ${lon} ${lonRef || ''}`;
      delete result['GPSLatitude'];
      delete result['GPSLatitudeRef'];
      delete result['GPSLongitude'];
      delete result['GPSLongitudeRef'];
    }

    const altRef = result['GPSAltitudeRef'];
    const alt = result['GPSAltitude'];
    if (alt) {
      result['GPSAltitude'] = altRef === '\x01' ? `-${alt}` : alt;
      delete result['GPSAltitudeRef'];
    }
  }

  return result;
}

export async function readExifData(filePath: string): Promise<ExifData | undefined> {
  try {
    const fd = await fs.promises.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(65536);
      const { bytesRead } = await fd.read(buf, 0, 65536, 0);
      return parseExifFromBuffer(buf.subarray(0, bytesRead));
    } finally {
      await fd.close();
    }
  } catch {
    return undefined;
  }
}
