import "@getpaseo/plugin/client";

// COMPAT(screen-runtime-title): added in Paseo v0.15.3 FSH; remove after SDK publication (2026-12-17).
// Mirrors PluginScreenProps.setTitle in packages/plugin/src/client/contracts.ts of fullstackhouse/paseo.
declare module "@getpaseo/plugin/client" {
  interface PluginScreenProps {
    setTitle?: (title: { label: string; tooltip?: string } | null) => void;
  }
}
