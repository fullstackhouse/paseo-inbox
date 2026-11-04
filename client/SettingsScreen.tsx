import { useRpc, useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { ConfigSchema, isUnconfigured, type Config } from "../shared/inbox";
import { inboxSettings, readLegacyConfig } from "../shared/settings";
import { parseTrust } from "../shared/trust";

type Ready = Extract<SettingsState<typeof inboxSettings.schema>, { status: "ready" }>;

const POLL = [
  { label: "Every minute", value: "60" },
  { label: "Every 5 minutes", value: "300" },
  { label: "Every 15 minutes", value: "900" },
  { label: "Every 30 minutes", value: "1800" },
] as const;
const AGENTS = ["1", "2", "3", "4"].map((value) => ({ label: value, value }));

const checkoutsText = (config: Config) =>
  Object.entries(config.checkouts)
    .map(([repo, path]) => `${repo} ${path}`)
    .join("\n");
const rulesText = (config: Config) => JSON.stringify({ sources: config.sources, rules: config.rules, manualRule: config.manualRule }, null, 2);

/** Settings → Inbox: everything inbox.json held, plus trust, in Paseo's own settings store. */
export function InboxSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(inboxSettings);
  const text = { color: theme.colors.foreground };
  if (settings.status === "loading") return <Text style={text}>Loading settings…</Text>;
  if (settings.status !== "ready")
    return (
      <SettingsSection title="Inbox">
        <Text style={text}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? <SettingsAction label="Restore default settings" actionLabel="Reset" onPress={settings.reset} /> : null}
      </SettingsSection>
    );
  return <Form settings={settings} theme={theme} />;
}

function Form({ settings, theme }: { settings: Ready; theme: PluginSurfaceProps["theme"] }) {
  const values = settings.values;
  const save = (patch: Partial<Config>) => void settings.save({ ...values, ...patch }, settings.revision);
  const legacy = useRpc(readLegacyConfig);
  const [legacyConfig, setLegacyConfig] = useState<{ path: string; config: Config | null } | null>(null);
  useEffect(() => {
    void legacy({}).then(setLegacyConfig).catch(() => undefined);
  }, [legacy]);
  const unconfigured = isUnconfigured(values);
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };

  return (
    <View style={{ gap: 18 }}>
      {unconfigured && legacyConfig?.config ? (
        <SettingsSection title="Import">
          <SettingsCard>
            <SettingsAction
              label={`Use ${legacyConfig.path}`}
              hint="Until settings hold any sources or rules, the inbox reads that file. Importing copies it here; the file is then ignored."
              actionLabel="Import"
              disabled={settings.saving}
              onPress={() => void settings.save(legacyConfig.config!, settings.revision)}
            />
          </SettingsCard>
        </SettingsSection>
      ) : null}

      <SettingsSection title="Inbox">
        <SettingsCard>
          <SettingsSwitch label="Running" hint="Off pauses polling and new runs. Drafts stay readable and postable." value={values.enabled} disabled={settings.saving} onValueChange={(enabled) => save({ enabled })} />
          <SettingsSelect label="Check GitHub" value={String(values.pollSeconds) as (typeof POLL)[number]["value"]} options={POLL} disabled={settings.saving} onValueChange={(value) => save({ pollSeconds: Number(value) })} />
          <SettingsSelect label="Reviewers at once" value={String(Math.min(values.maxConcurrent, 4))} options={AGENTS} disabled={settings.saving} onValueChange={(value) => save({ maxConcurrent: Number(value) })} />
          <Field label="Model" hint="provider/model; `paseo provider models claude` lists them" value={values.provider} onSave={(provider) => save({ provider })} error={settings.saveError} />
          <Field label="Mode" hint="For trusted runs. Claude: auto. Untrusted runs always ask, and the inbox answers." value={values.mode} onSave={(mode) => save({ mode })} />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Trust">
        <TrustEditor theme={theme} rules={values.trust} disabled={settings.saving} onSave={(trust) => save({ trust })} />
      </SettingsSection>

      <SettingsSection title="Repos on this machine">
        <BlockEditor
          theme={theme}
          hint="One per line: owner/repo then the path of a local checkout. A review runs in a fresh worktree of it."
          value={checkoutsText(values)}
          parse={(input) => {
            const checkouts: Record<string, string> = {};
            for (const line of input.split("\n").map((row) => row.trim()).filter(Boolean)) {
              const [repo, ...path] = line.split(/\s+/);
              if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !path.length) throw new Error(`"${line}" should be owner/repo followed by a path`);
              checkouts[repo] = path.join(" ");
            }
            return { checkouts };
          }}
          onSave={save}
          disabled={settings.saving}
        />
      </SettingsSection>

      <SettingsSection title="Sources and rules">
        <Text style={muted}>Sources are GitHub PR searches. Rules say what to run on them. manualRule is the rule a pasted PR link runs.</Text>
        <BlockEditor
          theme={theme}
          value={rulesText(values)}
          mono
          parse={(input) => {
            const parsed = ConfigSchema.pick({ sources: true, rules: true, manualRule: true }).safeParse(JSON.parse(input));
            if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
            for (const rule of parsed.data.rules) if (!parsed.data.sources[rule.source]) throw new Error(`rule ${rule.name} uses unknown source "${rule.source}"`);
            return parsed.data;
          }}
          onSave={save}
          disabled={settings.saving}
        />
      </SettingsSection>
    </View>
  );
}

function Field({ label, hint, value, onSave, error }: { label: string; hint?: string; value: string; onSave: (value: string) => void; error?: string | null }) {
  const [draft, setDraft] = useState(value);
  return (
    <>
      <SettingsInput label={label} hint={hint} initialValue={value} onChangeText={setDraft} error={error} />
      {draft.trim() && draft !== value ? <SettingsAction label={`Save ${label.toLowerCase()}`} actionLabel="Save" onPress={() => onSave(draft.trim())} /> : null}
    </>
  );
}

function TrustEditor({ theme, rules, disabled, onSave }: { theme: PluginSurfaceProps["theme"]; rules: string[]; disabled: boolean; onSave: (rules: string[]) => void }) {
  const [draft, setDraft] = useState(rules.join(" "));
  const list = useMemo(() => draft.split(/[\s,]+/).filter(Boolean), [draft]);
  const { errors } = parseTrust(list);
  const changed = list.join(" ") !== rules.join(" ");
  return (
    <SettingsCard>
      <SettingsInput
        label="Trusted people"
        hint="Whose PRs may run commands during review: @login, @org/team, @org/*; ! denies. Nobody matches → read-only run (no commands, no credentials). Empty trusts nobody."
        initialValue={rules.join(" ")}
        placeholder="@fullstackhouse/* !@some-bot"
        onChangeText={setDraft}
        error={errors[0] ?? null}
      />
      {changed && !errors.length ? <SettingsAction label="Save trust rules" actionLabel="Save" disabled={disabled} onPress={() => onSave(list)} /> : null}
      <SettingsRow label="Now">
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{rules.length ? rules.join(", ") : "trusting nobody: every review is read-only"}</Text>
      </SettingsRow>
    </SettingsCard>
  );
}

/** A multi-line text setting that's parsed and validated before it saves. */
function BlockEditor({ theme, value, hint, parse, onSave, disabled, mono }: { theme: PluginSurfaceProps["theme"]; value: string; hint?: string; parse: (input: string) => Partial<Config>; onSave: (patch: Partial<Config>) => void; disabled: boolean; mono?: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  let error: string | null = null;
  let patch: Partial<Config> | null = null;
  try {
    patch = parse(draft);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return (
    <SettingsCard>
      {hint ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, padding: 12, paddingBottom: 0 }}>{hint}</Text> : null}
      <TextInput
        value={draft}
        onChangeText={setDraft}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        style={{ color: theme.colors.foreground, fontFamily: mono ? "monospace" : undefined, fontSize: 13, minHeight: 140, margin: 12, padding: 10, borderWidth: 1, borderColor: error ? theme.colors.statusDanger : theme.colors.border, borderRadius: 8, textAlignVertical: "top" }}
      />
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12, paddingHorizontal: 12, paddingBottom: 8 }}>{error}</Text> : null}
      {draft !== value && patch ? <SettingsAction label="Unsaved changes" actionLabel="Save" disabled={disabled} onPress={() => onSave(patch!)} /> : null}
    </SettingsCard>
  );
}
