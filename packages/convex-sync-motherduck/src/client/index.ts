// Public client-side API of the component. Fleshed out in Fase 2.
// Placeholder export keeps the module resolvable while scaffolding.

export const VERSION = "0.0.1";

export type SyncedTableSpec = {
  name: string;
  columns: ReadonlyArray<{ name: string; type: string }>;
};
