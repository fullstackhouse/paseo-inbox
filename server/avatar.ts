// FSH Paseo takes square avatars up to 16 KB; a 64 px forge avatar is 2-6 KB.
const AVATAR_SIZE = 64;
const MAX_AVATAR_BYTES = 16 * 1024;

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
 * answers 404). Any other failure throws, so the caller can say why the row has no avatar.
 */
export async function fetchAvatar(prUrl: string, login: string, fetchImpl: Fetch = fetch): Promise<string | null> {
  const response = await fetchImpl(avatarUrl(prUrl, login));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Avatar for ${login}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_AVATAR_BYTES) throw new Error(`Avatar for ${login} is ${bytes.length} bytes, over ${MAX_AVATAR_BYTES}`);
  return bytes.toString("base64");
}
