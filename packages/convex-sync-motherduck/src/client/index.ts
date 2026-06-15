import type {
  GenericActionCtx,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import type {
  ColumnDef,
  Destination,
} from "@notchat/destination-types";
import { duckSqlType } from "@notchat/destination-types";
import {
  processSnapshotPage,
  type ProcessPageResult,
  type SnapshotIO,
} from "../snapshot/runner";
import {
  processDeltaBatch,
  type DeltaIO,
  type ProcessDeltaResult,
} from "../delta/runner";
import type { WatchdogTableState } from "../watchdog/index";

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
 * Resultado extendido de `processOneSnapshotPage` — incluye el caso de
 * cambio de tipo detectado, que dispara un re-snapshot automático.
 */
export type SnapshotResult =
  | ProcessPageResult
  | { kind: "type_reset"; changedColumns: string[] };

/**
 * Resultado extendido de `processOneDeltaBatch` — incluye el caso de
 * cambio de tipo detectado, que dispara un re-snapshot automático.
 */
export type DeltaResult =
  | ProcessDeltaResult
  | { kind: "type_reset"; changedColumns: string[] };

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
    // Delta stream — Fase 5
    _loadDeltaProgress: any;
    _saveDeltaProgress: any;
    _listRunningDeltaNames: any;
    // Watchdog — Fase 6
    _listTablesForWatchdog: any;
    _resetForReSnapshot: any;
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
  ): Promise<SnapshotResult> {
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

    // Detección de cambio de tipo (Fase 7). Sólo si la tabla ya existe en
    // el destino — en el primer snapshot no hay tabla todavía.
    const changedColumns = await detectTypeChanges(
      tableName,
      progress.columns as ReadonlyArray<ColumnDef>,
      destination,
    );
    if (changedColumns.length > 0) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "type_change_detected",
          tableName,
          changedColumns,
          action: "resetting for re-snapshot",
        }),
      );
      await ctx.runMutation(this.component.tables._resetForReSnapshot, {
        tableName,
      });
      return { kind: "type_reset", changedColumns };
    }

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

  // -------- API de delta stream — Fase 5 ------------------------------------

  /** Devuelve los nombres de tablas con `status: "running_delta"`. */
  async listRunningDeltaTables(ctx: GenericActionCtx<any>): Promise<string[]> {
    return await ctx.runQuery(
      this.component.tables._listRunningDeltaNames,
      {},
    );
  }

  /**
   * Procesa UN batch de deltas para `tableName` usando el `destination`
   * provisto por el caller. Devuelve `"more"` si quedan cambios pendientes,
   * o `"idle"` si alcanzamos el live-head (no hay más cambios por ahora).
   */
  async processOneDeltaBatch(
    ctx: GenericActionCtx<any>,
    tableName: string,
    destination: Destination,
  ): Promise<DeltaResult> {
    const config = (await ctx.runQuery(this.component.config.get, {})) as
      | SyncConfig
      | null;
    if (!config?.origin || !config?.deployKey) {
      throw new Error(
        "syncConfig incomplete: origin and deployKey are required",
      );
    }

    const progress = (await ctx.runQuery(
      this.component.tables._loadDeltaProgress,
      { tableName },
    )) as {
      columns: ReadonlyArray<{ name: string; type: string }>;
      cursor: string;
      rowsApplied: number;
    };

    // Detección de cambio de tipo (Fase 7).
    const changedColumns = await detectTypeChanges(
      tableName,
      progress.columns as ReadonlyArray<ColumnDef>,
      destination,
    );
    if (changedColumns.length > 0) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "type_change_detected",
          tableName,
          changedColumns,
          action: "resetting for re-snapshot",
        }),
      );
      await ctx.runMutation(this.component.tables._resetForReSnapshot, {
        tableName,
      });
      return { kind: "type_reset", changedColumns };
    }

    const io: DeltaIO = {
      loadProgress: async () => ({
        cursor: progress.cursor,
        rowsApplied: progress.rowsApplied,
      }),
      saveProgress: async (_t, p) => {
        await ctx.runMutation(this.component.tables._saveDeltaProgress, {
          tableName,
          cursor: p.cursor,
          rowsApplied: p.rowsApplied,
        });
      },
      logWarning: (message, c) => {
        console.warn(`[motherduck-sync] ${message}`, c);
      },
    };

    return processDeltaBatch({
      origin: config.origin,
      deployKey: config.deployKey,
      table: {
        name: tableName,
        columns: progress.columns as ReadonlyArray<{
          name: string;
          type: any;
        }>,
      },
      destination,
      io,
    });
  }

  // -------- API de watchdog — Fase 6 ----------------------------------------

  /** Devuelve el estado de todas las tablas para que el watchdog decida. */
  async listTablesForWatchdog(
    ctx: GenericActionCtx<any>,
  ): Promise<WatchdogTableState[]> {
    return await ctx.runQuery(
      this.component.tables._listTablesForWatchdog,
      {},
    );
  }

  /**
   * Resetea una tabla a `pending` para forzar un re-snapshot completo.
   * El watchdog llama esto cuando detecta que la tabla fue borrada del destino.
   */
  async resetForReSnapshot(
    ctx: GenericActionCtx<any>,
    tableName: string,
  ): Promise<void> {
    await ctx.runMutation(this.component.tables._resetForReSnapshot, {
      tableName,
    });
  }
}

// ---------------------------------------------------------------------------
// Schema migrations — Fase 7
// ---------------------------------------------------------------------------

/**
 * Compara las columnas declaradas contra los tipos actuales en el destino.
 * Devuelve los nombres de columnas cuyo SQL type difiere del declarado.
 *
 * - Columnas no presentes en el destino se ignoran (la migración aditiva las
 *   agrega con `ALTER TABLE`, no son un cambio de tipo).
 * - `_id` se ignora (siempre VARCHAR PRIMARY KEY, invariante del sistema).
 * - `bigint` y `timestamp_ms` se tratan como equivalentes (ambos → BIGINT)
 *   — un cambio entre ellos no requiere re-snapshot.
 */
export async function detectTypeChanges(
  tableName: string,
  declared: ReadonlyArray<ColumnDef>,
  destination: Pick<Destination, "columnTypes">,
): Promise<string[]> {
  const actual = await destination.columnTypes(tableName);
  if (actual.size === 0) return []; // Tabla no existe aún: nada que comparar.

  const changed: string[] = [];
  for (const col of declared) {
    if (col.name === "_id") continue;
    const actualType = actual.get(col.name);
    if (actualType === undefined) continue; // Columna nueva → migración aditiva, no cambio.
    const expectedType = duckSqlType(col.type as any).toUpperCase();
    if (actualType !== expectedType) {
      changed.push(col.name);
    }
  }
  return changed;
}

// Re-exports útiles para que el host pueda importar tipos sin saltar paquetes.
export type {
  Destination,
  DuckDestinationOptions,
} from "@notchat/destination-types";
export type { ProcessPageResult, SnapshotIO } from "../snapshot/runner";
export type { ProcessDeltaResult, DeltaIO } from "../delta/runner";
export type { WatchdogTableState, WatchdogAction, WatchdogConfig } from "../watchdog/index";
export { watchdogDecide } from "../watchdog/index";
