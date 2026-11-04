import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** The system browser on this machine: `open` on macOS, `xdg-open` on Linux, `start` on Windows. */
export async function openInBrowser(url: string, platform = process.platform, run = exec): Promise<void> {
  if (!/^https?:\/\//.test(url)) throw new Error("Only http(s) links");
  if (platform === "darwin") await run("open", [url]);
  else if (platform === "win32") await run("cmd", ["/c", "start", "", url]);
  else await run("xdg-open", [url]);
}
