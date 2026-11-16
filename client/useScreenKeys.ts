import { useEffect, useRef, type RefObject } from "react";
import { Platform } from "react-native";

// The client compiles without the DOM lib (it runs on native too), so the few DOM shapes used here are typed locally.
type El = { contains(other: unknown): boolean; getClientRects(): { length: number }; isContentEditable?: boolean; tagName?: string };
type Key = { key: string; target: unknown; metaKey: boolean; ctrlKey: boolean; altKey: boolean; preventDefault(): void };
type Doc = { addEventListener(type: string, listener: (event: never) => void, capture?: boolean): void; removeEventListener(type: string, listener: (event: never) => void, capture?: boolean): void };

/**
 * Single-key shortcuts for a plugin screen on web. A key reaches `onKey` (true = handled) only after
 * the last click landed inside `root`, since another pane may sit beside the screen; never while
 * typing in a field, and never while the screen is hidden.
 */
export function useScreenKeys(root: RefObject<unknown>, onKey: (key: string) => boolean) {
  const handler = useRef(onKey);
  handler.current = onKey;
  useEffect(() => {
    const doc = (globalThis as { document?: Doc }).document;
    if (Platform.OS !== "web" || !doc) return;
    let armed = false;
    const node = () => root.current as El | null;
    const onPointer = (event: { target: unknown }) => {
      armed = Boolean(node()?.contains(event.target));
    };
    const onKeyDown = (event: Key) => {
      const target = event.target as El | null;
      if (!armed || event.metaKey || event.ctrlKey || event.altKey || !node()?.getClientRects().length) return;
      if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName ?? ""))) return;
      if (handler.current(event.key)) event.preventDefault();
    };
    doc.addEventListener("pointerdown", onPointer, true);
    doc.addEventListener("keydown", onKeyDown);
    return () => {
      doc.removeEventListener("pointerdown", onPointer, true);
      doc.removeEventListener("keydown", onKeyDown);
    };
  }, [root]);
}
