import { describe, expect, it } from "vitest";
import { avatarUrl, fetchAvatar } from "../server/avatar";

const respond = (status: number, bytes = Buffer.alloc(0)) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
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
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await expect(fetchAvatar("https://github.com/a/b/pull/1", "ola", respond(200, png))).resolves.toBe(png.toString("base64"));
  });

  it("returns null when the forge has no avatar for the login", async () => {
    await expect(fetchAvatar("https://github.com/a/b/pull/1", "renovate[bot]", respond(404))).resolves.toBeNull();
  });

  it("throws on other failures and on images Paseo would refuse", async () => {
    await expect(fetchAvatar("https://github.com/a/b/pull/1", "ola", respond(503))).rejects.toThrow("HTTP 503");
    await expect(fetchAvatar("https://github.com/a/b/pull/1", "ola", respond(200, Buffer.alloc(17 * 1024)))).rejects.toThrow("over 16384");
  });
});
