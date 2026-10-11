const decoder = new TextDecoder();

const field = (block: Uint8Array, start: number, length: number) => decoder.decode(block.subarray(start, start + length)).replace(/\0.*$/s, "");

/** Pax extended header records: `<len> key=value\n`. */
function paxPath(data: Uint8Array): string | undefined {
  const text = decoder.decode(data);
  for (let i = 0; i < text.length; ) {
    const space = text.indexOf(" ", i);
    const len = Number(text.slice(i, space));
    if (!len) break;
    const record = text.slice(space + 1, i + len - 1);
    if (record.startsWith("path=")) return record.slice(5);
    i += len;
  }
  return undefined;
}

/**
 * Regular files of a tar archive (ustar, with pax and GNU long names), as path → bytes.
 * Enough for the archives GitHub serves; not a general-purpose tar reader.
 */
export function untar(archive: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let longName: string | undefined;
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(field(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156]!);
    const data = archive.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      longName = paxPath(data) ?? longName;
      continue;
    }
    if (type === "L") {
      longName = decoder.decode(data).replace(/\0.*$/s, "");
      continue;
    }
    const prefix = field(header, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = undefined;
    if (type === "0" || type === "\0") files.set(name, data);
  }
  return files;
}
