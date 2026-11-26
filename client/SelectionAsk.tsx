import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Platform, Text, View } from "react-native";
import { quoteFor } from "../shared/selection";
import { AskBox } from "./CommentCard";
import { Chip, MONO } from "./ui";

// The client compiles without the DOM lib (it runs on native too), so the DOM shapes used here are typed locally.
type Rect = { top: number; bottom: number; left: number; width: number; height: number };
type El = { contains(other: unknown): boolean; getBoundingClientRect(): Rect };
type Range = { commonAncestorContainer: unknown; startContainer: unknown; getBoundingClientRect(): Rect; cloneRange(): Range };
type Selection = { isCollapsed: boolean; rangeCount: number; getRangeAt(index: number): Range; toString(): string; removeAllRanges(): void };
type Doc = { addEventListener(type: string, listener: (event: never) => void, capture?: boolean): void; removeEventListener(type: string, listener: (event: never) => void, capture?: boolean): void };
type Observer = { observe(target: unknown): void; disconnect(): void };
type Win = { getSelection(): Selection | null; document?: Doc; ResizeObserver?: new (callback: () => void) => Observer } & Doc;

const win = () => (Platform.OS === "web" ? (globalThis as unknown as Partial<Win>) : null);

/** True while the human has text selected on web: a drag across a diff line ends in a click that shouldn't open the composer. */
export function hasTextSelection(): boolean {
  const selection = win()?.getSelection?.();
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
}

type Picked = { quote: string; about: string; top: number; left: number };

const ASK_WIDTH = 420;

/**
 * "Ask about this" for any text the human selects inside `container` (web only; native Text has no
 * selection API). A chip appears under the selection; pressing it opens a question box quoting the
 * selection, and `onAsk` sends it to the reviewer. Render it as the last child of `container`: it
 * positions itself absolutely there, so it scrolls with the text. `about(node)` names where the
 * selection starts ("the diff of src/a.ts"); `resetKey` changing (another tab or review) closes it.
 */
export function SelectionAsk({
  theme,
  container,
  about,
  onAsk,
  resetKey,
}: {
  theme: PluginTheme;
  container: RefObject<unknown>;
  about: (node: unknown) => string;
  onAsk: (question: string, about: string, quote: string) => Promise<boolean>;
  resetKey: string;
}) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [asking, setAsking] = useState(false);
  const overlay = useRef<View>(null);
  const aboutRef = useRef(about);
  aboutRef.current = about;
  const askingRef = useRef(asking);
  askingRef.current = asking;
  // The selected text, kept so the chip can follow it when the layout above it moves.
  const range = useRef<Range | null>(null);

  const close = () => {
    range.current = null;
    setPicked(null);
    setAsking(false);
  };
  useEffect(close, [resetKey]);

  useEffect(() => {
    const w = win();
    const doc = w?.document;
    if (!w?.getSelection || !doc) return;
    const inOverlay = (target: unknown) => Boolean((overlay.current as El | null)?.contains(target));
    /** Where the chip sits under `selected`, in the container; null once that text left the page (its file folded away). */
    const placeUnder = (selected: Range) => {
      const box = container.current as El | null;
      const rect = selected.getBoundingClientRect();
      if (!box || !box.contains(selected.startContainer) || (!rect.width && !rect.height)) return null;
      const bounds = box.getBoundingClientRect();
      return { top: rect.bottom - bounds.top + 6, left: Math.max(0, Math.min(rect.left - bounds.left, bounds.width - Math.min(ASK_WIDTH, bounds.width))) };
    };
    const read = () => {
      // A question being typed keeps its quote, whatever gets selected meanwhile.
      if (askingRef.current) return;
      const box = container.current as El | null;
      const selection = w.getSelection!();
      if (!box || !selection || selection.isCollapsed || !selection.rangeCount) return close();
      const selected = selection.getRangeAt(0).cloneRange();
      if (!box.contains(selected.commonAncestorContainer) || inOverlay(selected.commonAncestorContainer)) return close();
      const quote = quoteFor(selection.toString());
      const place = placeUnder(selected);
      if (!quote || !place) return close();
      range.current = selected;
      setPicked({ quote, about: aboutRef.current(selected.startContainer), ...place });
    };
    // Folding a file, ticking Viewed or resizing moves the text: move the chip with it, or close it if
    // the text is gone. A question being typed stays where it is rather than vanish with its text.
    const follow = () => {
      if (!range.current) return;
      const place = placeUnder(range.current);
      if (place) setPicked((current) => (current ? { ...current, ...place } : current));
      else if (!askingRef.current) close();
    };
    const observer = w.ResizeObserver ? new w.ResizeObserver(follow) : null;
    if (container.current) observer?.observe(container.current);
    w.addEventListener?.("resize", follow);
    // Read once the gesture ends, not on every selectionchange, so the chip doesn't chase the drag.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => timer && clearTimeout(timer);
    const onEnd = (event: { target: unknown }) => {
      if (inOverlay(event.target)) return;
      stop();
      timer = setTimeout(read, 0);
    };
    doc.addEventListener("mouseup", onEnd);
    doc.addEventListener("touchend", onEnd);
    doc.addEventListener("keyup", onEnd);
    return () => {
      stop();
      observer?.disconnect();
      w.removeEventListener?.("resize", follow);
      doc.removeEventListener("mouseup", onEnd);
      doc.removeEventListener("touchend", onEnd);
      doc.removeEventListener("keyup", onEnd);
    };
  }, [container]);

  if (!picked) return null;
  const small = { paddingVertical: 4, paddingHorizontal: 10 };
  return (
    <View
      ref={overlay}
      style={[
        { position: "absolute", top: picked.top, left: picked.left, zIndex: 20 },
        asking
          ? { width: ASK_WIDTH, maxWidth: "100%", gap: 8, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.accent, backgroundColor: theme.colors.surface1, ...SHADOW }
          : null,
      ]}
    >
      {asking ? (
        <>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>About {picked.about}</Text>
          <Text numberOfLines={4} style={{ color: theme.colors.foreground, fontFamily: MONO, fontSize: 12, borderLeftWidth: 3, borderLeftColor: theme.colors.border, paddingLeft: 8 }}>
            {picked.quote}
          </Text>
          <AskBox
            theme={theme}
            onCancel={close}
            onAsk={async (question) => {
              if (!(await onAsk(question, picked.about, picked.quote))) return;
              close();
              win()?.getSelection?.()?.removeAllRanges();
            }}
          />
        </>
      ) : (
        <Chip theme={theme} active label="Ask about this" style={{ ...small, ...SHADOW }} textStyle={{ fontSize: 12 }} onPress={() => setAsking(true)} />
      )}
    </View>
  );
}

// react-native-web turns these into a box-shadow; native ignores them here (the component never renders there).
const SHADOW = { shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } };
