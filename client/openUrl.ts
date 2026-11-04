import { useRpc } from "@getpaseo/plugin/client";
import { useCallback } from "react";
import { Linking } from "react-native";
import { openExternal } from "../shared/review";

// Paseo's desktop app opens window.open() links in its own window, which isn't signed in to GitHub, so
// private repos 404 there. In the desktop app the daemon runs on the same machine, so it opens the
// link in the system browser instead. Phones and plain browsers open it themselves.
const inDesktopApp = () => /Electron/.test(String((globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? ""));

export function useOpenUrl() {
  const open = useRpc(openExternal);
  return useCallback(
    (url: string) => {
      if (inDesktopApp()) void open({ url }).catch(() => void Linking.openURL(url));
      else void Linking.openURL(url);
    },
    [open],
  );
}
