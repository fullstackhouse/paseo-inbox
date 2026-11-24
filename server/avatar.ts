// FSH Paseo takes square avatars up to 256×256 and 16 KB; a 64 px forge avatar is 2-6 KB.
const AVATAR_SIZE = 64;
const MAX_AVATAR_BYTES = 16 * 1024;
const MAX_AVATAR_SIDE = 256;

type Fetch = (url: string) => Promise<Pick<Response, "ok" | "status" | "arrayBuffer">>;

/**
 * Where the forge serves `login`'s avatar: `<origin>/<login>.png` redirects to the image on GitHub
 * and GitHub Enterprise alike, so the PR's own origin picks the right server.
 */
export function avatarUrl(prUrl: string, login: string): string {
  const url = new URL(`/${encodeURIComponent(login)}.png`, new URL(prUrl).origin);
  url.searchParams.set("size", String(AVATAR_SIZE));
  return url.toString();
}

/**
 * The PR author's avatar as base64, or null when the forge has none for them (a bot account
 * answers 404). Any other failure throws, so the caller can say why the row has no avatar; that
 * includes an image Paseo would refuse, such as GitHub's default identicon, which ignores the
 * requested size and comes back 420×420.
 */
export async function fetchAvatar(prUrl: string, login: string, fetchImpl: Fetch = fetch): Promise<string | null> {
  const response = await fetchImpl(avatarUrl(prUrl, login));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Avatar for ${login}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_AVATAR_BYTES) throw new Error(`Avatar for ${login} is ${bytes.length} bytes, over ${MAX_AVATAR_BYTES}`);
  const size = imageSize(bytes);
  if (!size) throw new Error(`Avatar for ${login} isn't a PNG, JPEG, GIF or WebP image whose size can be read`);
  if (size.width !== size.height || size.width > MAX_AVATAR_SIDE) {
    throw new Error(`Avatar for ${login} is ${size.width}×${size.height}, not a square up to ${MAX_AVATAR_SIDE}×${MAX_AVATAR_SIDE}`);
  }
  return bytes.toString("base64");
}

type Size = { width: number; height: number };

/** The pixel size of a PNG, GIF, JPEG or WebP (the formats Paseo takes) from its header, or null for anything else or a truncated file. */
export function imageSize(bytes: Buffer): Size | null {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString("latin1", 12, 16) === "IHDR") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 10 && bytes.toString("latin1", 0, 3) === "GIF") {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes);
  if (bytes.length >= 30 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return webpSize(bytes);
  return null;
}

// The first chunk of a WebP says how it is coded, and each coding keeps the size in its own place.
function webpSize(bytes: Buffer): Size | null {
  switch (bytes.toString("latin1", 12, 16)) {
    case "VP8 ": // lossy: 14-bit sizes after the key frame's start code
      if (bytes.readUIntBE(23, 3) !== 0x9d012a) return null;
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    case "VP8L": {
      // lossless: two 14-bit sizes minus one, packed after the 0x2f signature
      if (bytes[20] !== 0x2f) return null;
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case "VP8X": // extended: 24-bit canvas sizes minus one
      return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    default:
      return null;
  }
}

// Start-of-frame markers carry the size; C4 (Huffman tables), C8 (reserved) and CC (arithmetic coding) don't.
const isStartOfFrame = (marker: number) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function jpegSize(bytes: Buffer): Size | null {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    // Fill bytes before a marker, and markers that have no length field.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (isStartOfFrame(marker)) {
      if (offset + 9 > bytes.length) return null;
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}
