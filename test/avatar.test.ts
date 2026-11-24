import { describe, expect, it, vi } from "vitest";
import { markReviewWorkspace } from "../index.server";
import { avatarUrl, fetchAvatar, imageSize } from "../server/avatar";

// The headers a size reader looks at, followed by a few bytes of image data.
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR"), ihdr, Buffer.alloc(4), Buffer.alloc(32)]);
}

function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const tables = Buffer.from([0xff, 0xc4, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc2, 0);
  sof.writeUInt16BE(17, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, Buffer.from([0xff]), tables, sof, Buffer.alloc(16)]);
}

const respond = (status: number, bytes: Buffer = Buffer.alloc(0)) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  arrayBuffer: async () => new Uint8Array(bytes).buffer,
});

describe("avatarUrl", () => {
  it("asks the PR's own forge for a 64 px image", () => {
    expect(avatarUrl("https://github.com/acme/shop/pull/7", "ola")).toBe("https://github.com/ola.png?size=64");
    expect(avatarUrl("https://git.example.com/acme/shop/pull/7", "ola")).toBe("https://git.example.com/ola.png?size=64");
  });

  it("escapes logins that aren't path-safe, like bot accounts", () => {
    expect(avatarUrl("https://github.com/acme/shop/pull/7", "renovate[bot]")).toBe("https://github.com/renovate%5Bbot%5D.png?size=64");
  });
});

describe("fetchAvatar", () => {
  it("returns the image as base64", async () => {
    const image = png(64, 64);
    await expect(fetchAvatar("https://github.com/a/b/pull/1", "ola", respond(200, image))).resolves.toBe(image.toString("base64"));
  });

  it("returns null when the forge has no avatar for the login", async () => {
    await expect(fetchAvatar("https://github.com/a/b/pull/1", "renovate[bot]", respond(404))).resolves.toBeNull();
  });

  it("throws on other failures and on images Paseo would refuse", async () => {
    await expect(fetchAvatar("https://github.com/a/b/pull/1", "ola", respond(503))).rejects.toThrow("HTTP 503");
    await expect(fetchAvatar("https://github.com/a/b/pull/1", "ola", respond(200, Buffer.alloc(17 * 1024)))).rejects.toThrow("over 16384");
  });

  it("throws on a default identicon, which GitHub serves at 420×420 whatever size was asked", async () => {
    await expect(fetchAvatar("https://github.com/a/b/pull/1", "ola", respond(200, png(420, 420)))).rejects.toThrow("420×420, not a square up to 256×256");
  });

  it("throws on an image that isn't square, or whose size can't be read", async () => {
    await expect(fetchAvatar("https://github.com/a/b/pull/1", "ola", respond(200, jpeg(64, 48)))).rejects.toThrow("64×48");
    await expect(fetchAvatar("https://github.com/a/b/pull/1", "ola", respond(200, Buffer.from("<html>")))).rejects.toThrow("size can be read");
  });
});

// A RIFF container holding one chunk, padded so every size field is in reach.
function webp(chunk: string, header: number[]): Buffer {
  const body = Buffer.concat([Buffer.from(header), Buffer.alloc(16)]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.from(chunk), size, body]);
}

describe("imageSize", () => {
  it("reads PNG, GIF and JPEG headers", () => {
    expect(imageSize(png(420, 420))).toEqual({ width: 420, height: 420 });
    const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([64, 0, 32, 0]), Buffer.alloc(8)]);
    expect(imageSize(gif)).toEqual({ width: 64, height: 32 });
    expect(imageSize(jpeg(64, 48))).toEqual({ width: 64, height: 48 });
  });

  it("reads all three WebP codings, which Paseo also takes", () => {
    // Lossy: frame tag, start code 9d 01 2a, then 14-bit width and height.
    expect(imageSize(webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 64, 0, 48, 0]))).toEqual({ width: 64, height: 48 });
    // Lossless: signature 0x2f, then width-1 and height-1 in 14 bits each (63 and 47).
    const bits = 63 | (47 << 14);
    expect(imageSize(webp("VP8L", [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, bits >>> 24]))).toEqual({ width: 64, height: 48 });
    // Extended: flags, reserved, then 24-bit width-1 and height-1 (419 = 0x0001a3).
    expect(imageSize(webp("VP8X", [0, 0, 0, 0, 0xa3, 0x01, 0x00, 0xa3, 0x01, 0x00]))).toEqual({ width: 420, height: 420 });
  });

  it("returns null for other formats and truncated files", () => {
    expect(imageSize(Buffer.from("BM6\0\0\0"))).toBeNull();
    expect(imageSize(Buffer.from("RIFF....WEBP"))).toBeNull();
    expect(imageSize(png(64, 64).subarray(0, 20))).toBeNull();
    expect(imageSize(jpeg(64, 64).subarray(0, 30))).toBeNull();
  });
});

describe("markReviewWorkspace", () => {
  const pr = { url: "https://github.com/a/b/pull/1", author: "ola" };
  const host = (setAppearance: (appearance: unknown) => Promise<unknown>) => ({ workspaces: { ref: () => ({ setAppearance }) } }) as never;

  it("sets the avatar and the Inbox icon in one call", async () => {
    const setAppearance = vi.fn(async () => undefined);
    await markReviewWorkspace(host(setAppearance), "ws", pr, async () => "AVATAR");
    expect(setAppearance.mock.calls).toEqual([[{ avatar: "AVATAR", titleIcon: "Inbox" }]]);
  });

  it("still sets the Inbox icon when Paseo refuses the avatar", async () => {
    const setAppearance = vi.fn(async (appearance: unknown) => {
      if ((appearance as { avatar: string | null }).avatar) throw new Error("Avatar must be a square image up to 256×256");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await markReviewWorkspace(host(setAppearance), "ws", pr, async () => "AVATAR");
    logged.mockRestore();
    expect(setAppearance.mock.calls).toEqual([[{ avatar: "AVATAR", titleIcon: "Inbox" }], [{ avatar: null, titleIcon: "Inbox" }]]);
  });

  it("doesn't retry a call that had no avatar to blame", async () => {
    const setAppearance = vi.fn(async () => Promise.reject(new Error("workspace gone")));
    await expect(markReviewWorkspace(host(setAppearance), "ws", pr, async () => null)).rejects.toThrow("workspace gone");
    expect(setAppearance).toHaveBeenCalledTimes(1);
  });
});
