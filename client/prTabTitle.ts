import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useEffect } from "react";

type TitledPr = { repo: string; number: number; title: string };

/** Names the screen's tab after its PR, so two open reviews don't both read "Review". Returns the label. */
export function usePrTabTitle(setTitle: PluginScreenProps["setTitle"], pr: TitledPr | null | undefined) {
  const label = pr ? `#${pr.number} ${pr.title}` : "";
  const tooltip = pr ? `${pr.repo}#${pr.number} ${pr.title}` : "";
  useEffect(() => {
    if (label) setTitle?.({ label, tooltip });
  }, [label, tooltip, setTitle]);
  return label;
}
