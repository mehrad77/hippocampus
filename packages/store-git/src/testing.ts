// Test helpers for the fake git hosts (`FakeGitHub`, `FakeGitLab`).

const encoder = new TextEncoder();

function tarHeader(name: string, size: number, type: string): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, at: number) => h.set(encoder.encode(s), at);
  put(name.slice(0, 99), 0);
  put("0000644\0", 100);
  put(`${size.toString(8).padStart(11, "0")}\0`, 124);
  put("00000000000\0", 136);
  put("        ", 148);
  put(type, 156);
  put("ustar\0" + "00", 257);
  const sum = h.reduce((a, b) => a + b, 0);
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}

const pad = (n: number) => new Uint8Array((512 - (n % 512)) % 512);

/** A gzipped tarball shaped like a git host's archive: one top-level directory, pax headers for long paths. */
export async function tarball(root: string, files: [string, string][]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (const [path, content] of files) {
    const name = `${root}/${path}`;
    if (name.length > 99) {
      const record = (len: number) => `${len} path=${name}\n`;
      let len = record(0).length;
      while (record(len).length !== len) len = record(len).length;
      const pax = encoder.encode(record(len));
      parts.push(tarHeader("pax_header", pax.length, "x"), pax, pad(pax.length));
    }
    const body = encoder.encode(content);
    parts.push(tarHeader(name, body.length, "0"), body, pad(body.length));
  }
  parts.push(new Uint8Array(1024));
  const stream = new Blob(parts as Uint8Array<ArrayBuffer>[]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
