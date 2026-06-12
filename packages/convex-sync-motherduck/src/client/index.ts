import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";

export const VERSION = "0.1.0";

export type ColumnSpec = { name: string; type: string };

export type SyncedTableSpec = {
  name: string;
  columns: ReadonlyArray<ColumnSpec>;
};

export type Destination =
  | { kind: "duckdb_local"; path: string }
  | { kind: "motherduck"; databaseUrl: string };

export type SyncConfig = {
  origin?: string;
  deployKey?: string;
  motherduckToken?: string;
  destination?: Destination;
};

export type SyncStatus =
  | "idle"
  | "pending"
  | "running_snapshot"
  | "running_delta"
  | "error"
  | "paused";

export type TableStatus = {
  name: string;
  status: SyncStatus;
  lastCursor: string | undefined;
  snapshotTs: number | undefined;
  lastError: string | undefined;
  rowsApplied: number;
};

// Convex todavía no genera tipos fuertes para `components.<name>` (el
// `ComponentApi<"name">` queda como `{}`). Hasta que lo haga, modelamos
// la referencia internamente como `any` y exponemos métodos tipados.
type ComponentRef = {
  config: { set: any; get: any };
  tables: { register: any; status: any };
};

export class MotherduckSync {
  constructor(private readonly component: ComponentRef) {}

  async setConfig(
    ctx: GenericMutationCtx<any>,
    config: SyncConfig,
  ): Promise<void> {
    await ctx.runMutation(this.component.config.set, config);
  }

  async registerSyncedTables(
    ctx: GenericMutationCtx<any>,
    tables: ReadonlyArray<SyncedTableSpec>,
  ): Promise<void> {
    await ctx.runMutation(this.component.tables.register, {
      tables: tables.map((t) => ({
        name: t.name,
        columns: t.columns.map((c) => ({ name: c.name, type: c.type })),
      })),
    });
  }

  async status(ctx: GenericQueryCtx<any>): Promise<TableStatus[]> {
    return await ctx.runQuery(this.component.tables.status, {});
  }
}
