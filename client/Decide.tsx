import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useState } from "react";
import { ActivityIndicator, Switch, Text, TextInput, View } from "react-native";
import type { ReviewDraft } from "../shared/review";
import { Markdown } from "./Markdown";
import { Chip, MONO } from "./ui";

type Preview = { event: string; body: string; generatedBody: string; edited: boolean; comments: { path: string; line: number; body: string }[]; replies: { commentId: number; body: string }[]; folded: number; held: number };

/**
 * Exactly what Post will send, computed against GitHub's live diff: the event, the body, every inline
 * comment, replies in other reviewers' threads, and what's held back. The body can be edited by hand;
 * the edit replaces the composed body until it's reset.
 */
export function PreviewPane({ theme, stamp, editable, load, saveBody, onDraft }: { theme: PluginTheme; runId: string; stamp: string; editable: boolean; load: () => Promise<Preview>; saveBody: (body: string | null) => Promise<ReviewDraft>; onDraft: (draft: ReviewDraft) => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void load()
      .then((value) => live && setPreview(value))
      .catch((caught) => live && setError(caught instanceof Error ? caught.message : String(caught)));
    return () => {
      live = false;
    };
    // `stamp` changes whenever the draft does, so the preview follows every edit.
  }, [stamp]); // eslint-disable-line react-hooks/exhaustive-deps
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  if (error) return <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{error}</Text>;
  if (!preview) return <ActivityIndicator color={theme.colors.foregroundMuted} />;
  const save = async (body: string | null) => {
    setBusy(true);
    try {
      onDraft(await saveBody(body));
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 12 }}>
      <Text style={muted}>
        Posts as <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{preview.event}</Text> · {preview.comments.length} inline · {preview.replies.length} repl{preview.replies.length === 1 ? "y" : "ies"} in others' threads
        {preview.folded ? ` · ${preview.folded} folded into the body` : ""}
        {preview.held ? ` · ${preview.held} held back (already raised)` : ""}
      </Text>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "700", fontSize: 15, flex: 1 }}>Review text{preview.edited ? " (edited by you)" : ""}</Text>
        {editable && !editing ? (
          <Chip
            theme={theme}
            label="Edit text"
            onPress={() => {
              setText(preview.body);
              setEditing(true);
            }}
          />
        ) : null}
        {editable && preview.edited && !editing ? <Chip theme={theme} label="Reset" disabled={busy} onPress={() => void save(null)} /> : null}
      </View>
      {editing ? (
        <>
          <TextInput value={text} onChangeText={setText} multiline autoFocus style={{ color: theme.colors.foreground, fontFamily: MONO, fontSize: 13, minHeight: 260, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10, textAlignVertical: "top" }} />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Chip theme={theme} active label={busy ? "Saving…" : "Save text"} disabled={busy} onPress={() => void save(text)} />
            <Chip theme={theme} label="Cancel" onPress={() => setEditing(false)} />
          </View>
        </>
      ) : (
        <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, padding: 12 }}>
          <Markdown text={preview.body} theme={theme} size={14} />
        </View>
      )}
      {preview.comments.length ? <Text style={{ color: theme.colors.foreground, fontWeight: "700", fontSize: 15 }}>Inline comments</Text> : null}
      {preview.comments.map((comment, index) => (
        <View key={index} style={{ borderLeftWidth: 2, borderLeftColor: theme.colors.border, paddingLeft: 10, gap: 4 }}>
          <Text style={muted}>
            {comment.path}:{comment.line}
          </Text>
          <Markdown text={comment.body} theme={theme} size={14} />
        </View>
      ))}
      {preview.replies.length ? <Text style={{ color: theme.colors.foreground, fontWeight: "700", fontSize: 15 }}>Replies in others' threads</Text> : null}
      {preview.replies.map((reply) => (
        <View key={reply.commentId} style={{ borderLeftWidth: 2, borderLeftColor: theme.colors.border, paddingLeft: 10 }}>
          <Markdown text={reply.body} theme={theme} size={14} />
        </View>
      ))}
    </View>
  );
}

/** Hand the review request to someone else, with a note and optionally your draft (as a comment). */
export function HandoffPanel({ theme, hasDraft, loadPeople, onHandoff, onCancel }: { theme: PluginTheme; hasDraft: boolean; loadPeople: () => Promise<{ me: string; people: string[] }>; onHandoff: (input: { to: string; note: string; sendDraft: boolean }) => void; onCancel: () => void }) {
  const [people, setPeople] = useState<string[] | null>(null);
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [sendDraft, setSendDraft] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    void loadPeople()
      .then((value) => setPeople(value.people))
      .catch(() => setPeople([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const login = to.trim().replace(/^@/, "");
  const valid = /^[A-Za-z0-9-]+$/.test(login);
  const shown = (people ?? []).filter((person) => !login || person.toLowerCase().includes(login.toLowerCase())).slice(0, 8);
  const input = { color: theme.colors.foreground, fontSize: 14, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 };
  return (
    <View style={{ gap: 8, borderWidth: 1, borderColor: theme.colors.accent, borderRadius: 10, padding: 12 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Hand off this review</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Requests their review, withdraws yours, and leaves a note that names them.</Text>
      <TextInput value={to} onChangeText={(value) => { setTo(value); setConfirming(false); }} placeholder="@login" placeholderTextColor={theme.colors.foregroundMuted} autoCapitalize="none" autoCorrect={false} style={input} />
      {shown.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {shown.map((person) => (
            <Chip key={person} theme={theme} label={`@${person}`} active={login === person} style={{ paddingVertical: 3, paddingHorizontal: 8 }} textStyle={{ fontSize: 12 }} onPress={() => setTo(person)} />
          ))}
        </View>
      ) : null}
      <TextInput value={note} onChangeText={setNote} placeholder="Note (optional): why them, what to look at" placeholderTextColor={theme.colors.foregroundMuted} multiline style={{ ...input, minHeight: 60, textAlignVertical: "top" }} />
      {hasDraft ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Switch value={sendDraft} onValueChange={setSendDraft} />
          <Text style={{ color: theme.colors.foreground, fontSize: 13, flex: 1 }}>Send my draft along, as a comment (never an approval or a request for changes)</Text>
        </View>
      ) : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Chip theme={theme} active label={confirming ? `Hand off to @${login}: sure?` : "Hand off"} disabled={!valid} onPress={() => (confirming ? onHandoff({ to: login, note, sendDraft }) : setConfirming(true))} />
        <Chip theme={theme} label="Cancel" onPress={onCancel} />
      </View>
    </View>
  );
}
