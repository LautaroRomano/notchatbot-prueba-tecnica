import type {
  GenericActionCtx,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import type {
  Destination,
} from "@notchat/destination-types";
import {
  processSnapshotPage,
  type ProcessPageResult,
  type SnapshotIO,
} from "../snapshot/runner";

export const VERSION = "0.1.0";

export type ColumnSpec = { name: string; type: string };

export type SyncedTableSpec = {
  name: string;
  columns: ReadonlyArray<ColumnSpec>;
};

export type DestinationConfig =
  | { kind: "duckdb_local"; path: string }
  | { kind: "motherduck"; databaseUrl: string };

export type SyncConfig = {
  origin?: string;
  deployKey?: string;
  motherduckToken?: string;
  destination?: DestinationConfig;
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
  lastAppliedAtMs?: number | undefined;
};

/**
 * Referencia al componente. Convex todavía no genera tipos fuertes para
 * `components.<name>` (queda como `{}`), así que internamente lo modelamos
 * como `any` y exponemos métodos tipados.
 *
 * Importante: TODAS las mutations/queries del componente (incluso las que
 * conceptualmente son "internas") tienen que ser PÚBLICAS (`mutation`,
 * `query`), porque Convex no permite invocar `internal*` de un componente
 * desde el host app. La convención `_nombre` es el marcador de "uso interno
 * del runner, no llamar directo".
 */
type ComponentRef = {
  config: { set: any; get: any };
  tables: {
    register: any;
    status: any;
    _listSyncTargets: any;
    _listPendingNames: any;
    _loadSnapshotProgress: any;
    _saveSnapshotProgress: any;
    _markSnapshotDone: any;
    _markError: any;
  };
};

export class MotherduckSync {
  constructor(private readonly component: ComponentRef) {}

  // -------- API "de aplicación" -----------------------------------------

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

  // -------- API "para el worker" ----------------------------------------
  //
  // El host app provee una action `"use node"` que abre el `Destination` y
  // llama a estos métodos. La action vive afuera del componente porque
  // Convex no soporta `"use node"` en componentes (limitación documentada).

  /** Devuelve los nombres de tablas con `status: "pending"`. */
  async listPendingTables(ctx: GenericActionCtx<any>): Promise<string[]> {
    return await ctx.runQuery(this.component.tables._listPendingNames, {});
  }

  /** Lee el singleton de config (incluye destination + secretos). */
  async getConfig(
    ctx: GenericActionCtx<any>,
  ): Promise<SyncConfig | null> {
    const cfg = await ctx.runQuery(this.component.config.get, {});
    return cfg as SyncConfig | null;
  }

  /** Marca una tabla en `error` con un mensaje (no toca el cursor). */
  async markError(
    ctx: GenericActionCtx<any>,
    tableName: string,
    error: string,
  ): Promise<void> {
    await ctx.runMutation(this.component.tables._markError, {
      tableName,
      error,
    });
  }

  /**
   * Procesa UNA página de snapshot para `tableName` usando el `destination`
   * provisto por el caller. Devuelve si quedan más páginas (`more`) o si el
   * snapshot terminó (`done` con `snapshotTs`).
   *
   * El caller (action `"use node"` del host) decide si self-schedulea otra
   * iteración o si cierra.
   */
  async processOneSnapshotPage(
    ctx: GenericActionCtx<any>,
    tableName: string,
    destination: Destination,
  ): Promise<ProcessPageResult> {
    const config = (await ctx.runQuery(this.component.config.get, {})) as
      | SyncConfig
      | null;
    if (!config?.origin || !config?.deployKey) {
      throw new Error(
        "syncConfig incomplete: origin and deployKey are required",
      );
    }
    const progress = (await ctx.runQuery(
      this.component.tables._loadSnapshotProgress,
      { tableName },
    )) as {
      columns: ReadonlyArray<{ name: string; type: string }>;
      cursor: string | undefined;
      rowsApplied: number;
    };

    const io: SnapshotIO = {
      loadProgress: async () => ({
        cursor: progress.cursor,
        rowsApplied: progress.rowsApplied,
      }),
      saveProgress: async (_t, p) => {
        await ctx.runMutation(this.component.tables._saveSnapshotProgress, {
          tableName,
          cursor: p.cursor!,
          rowsApplied: p.rowsApplied,
        });
      },
      markSnapshotDone: async (_t, ts) => {
        await ctx.runMutation(this.component.tables._markSnapshotDone, {
          tableName,
          snapshotTs: ts,
        });
      },
      logWarning: (message, c) => {
        console.warn(`[motherduck-sync] ${message}`, c);
      },
    };

    return processSnapshotPage({
      origin: config.origin,
      deployKey: config.deployKey,
      table: {
        name: tableName,
        // Cast: el componente persiste `type: string` (el dev declara strings
        // libres). El runner asume `LogicalType`; si el dev pone basura, el
        // destino va a reventar — preferimos eso a coerciones silenciosas.
        columns: progress.columns as ReadonlyArray<{ name: string; type: any }>,
      },
      destination,
      io,
    });
  }
}

// Re-exports útiles para que el host pueda importar tipos sin saltar paquetes.
export type {
  Destination,
  DuckDestinationOptions,
} from "@notchat/destination-types";
export type { ProcessPageResult, SnapshotIO } from "../snapshot/runner";
