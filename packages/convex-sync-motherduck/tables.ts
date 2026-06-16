import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const columnDef = v.object({
  name: v.string(),
  type: v.string(),
});

// Upsert por `name`. Si ya existe, actualizamos sólo `columns` — el estado
// de sync (cursor, snapshotTs, rowsApplied) se preserva. Esto permite que
// la app llame `registerSyncedTables` en cada deploy sin perder progreso.
export const register = mutation({
  args: {
    tables: v.array(
      v.object({
        name: v.string(),
        columns: v.array(columnDef),
      }),
    ),
  },
  handler: async (ctx, { tables }) => {
    for (const spec of tables) {
      const existing = await ctx.db
        .query("syncedTables")
        .withIndex("by_name", (q) => q.eq("name", spec.name))
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, { columns: spec.columns });
      } else {
        await ctx.db.insert("syncedTables", {
          name: spec.name,
          columns: spec.columns,
          status: "pending",
          rowsApplied: 0,
        });
      }
    }
  },
});

export const status = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("syncedTables").collect();
    return rows.map((r) => ({
      name: r.name,
      status: r.status,
      lastCursor: r.lastCursor,
      snapshotTs: r.snapshotTs,
      lastError: r.lastError,
      rowsApplied: r.rowsApplied,
      lastAppliedAtMs: r.lastAppliedAtMs,
    }));
  },
});

// ============================================================================
// "Internal" API — son `mutation`/`query` PÚBLICOS porque Convex no permite
// que el host app llame a `internal*` functions de un componente.
//
// Convención: prefijo `_` para señalar "esto es para uso del runner, no de
// código de la app". El cliente `MotherduckSync` los envuelve, así que el
// dev nunca debería llamar directamente. Documentar en README.
//
// El otro motivo por el que esto vive así: Convex no soporta `"use node"`
// adentro de componentes, así que la action que toca DuckDB tiene que vivir
// en `apps/<host>/convex/` y necesita poder invocar estas mutations para
// avanzar cursores.
// ============================================================================

/** Lista de tablas con su spec actual para que la action las procese. */
export const _listSyncTargets = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("syncedTables").collect();
    return rows.map((r) => ({
      name: r.name,
      columns: r.columns,
      status: r.status,
      lastCursor: r.lastCursor,
      snapshotTs: r.snapshotTs,
    }));
  },
});

/**
 * Devuelve los nombres de tablas con `status: "pending"`. Lo usa el cron
 * tick para arrancar snapshots de tablas recién registradas. Index `by_status`
 * hace esto barato aunque haya muchas tablas.
 */
export const _listPendingNames = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("syncedTables")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .collect();
    return rows.map((r) => r.name);
  },
});

/** Carga progreso del snapshot para una tabla. Devuelve cursor + count. */
export const _loadSnapshotProgress = query({
  args: { tableName: v.string() },
  handler: async (ctx, { tableName }) => {
    const row = await ctx.db
      .query("syncedTables")
      .withIndex("by_name", (q) => q.eq("name", tableName))
      .unique();
    if (!row) {
      throw new Error(`Table not registered: ${tableName}`);
    }
    const cursor = await ctx.db
      .query("syncCursors")
      .withIndex("by_table_kind", (q) =>
        q.eq("tableName", tableName).eq("kind", "snapshot"),
      )
      .unique();
    return {
      columns: row.columns,
      cursor: cursor?.cursor,
      rowsApplied: row.rowsApplied,
    };
  },
});

/**
 * Persiste el cursor + count tras aplicar exitosamente una página. También
 * mueve `status: pending → running_snapshot` la primera vez (idempotente).
 */
export const _saveSnapshotProgress = mutation({
  args: {
    tableName: v.string(),
    cursor: v.string(),
    rowsApplied: v.number(),
  },
  handler: async (ctx, { tableName, cursor, rowsApplied }) => {
    const row = await ctx.db
      .query("syncedTables")
      .withIndex("by_name", (q) => q.eq("name", tableName))
      .unique();
    if (!row) throw new Error(`Table not registered: ${tableName}`);

    await ctx.db.patch(row._id, {
      status: "running_snapshot",
      lastCursor: cursor,
      rowsApplied,
      lastAppliedAtMs: Date.now(),
      lastError: undefined,
    });

    const existing = await ctx.db
      .query("syncCursors")
      .withIndex("by_table_kind", (q) =>
        q.eq("tableName", tableName).eq("kind", "snapshot"),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { cursor });
    } else {
      await ctx.db.insert("syncCursors", {
        tableName,
        kind: "snapshot",
        cursor,
      });
    }
  },
});

/**
 * Cierre del snapshot: persiste `snapshotTs`, mueve `status → running_delta`
 * y deja todo listo para Fase 5. El cursor de snapshot ya estaba guardado
 * por el último `_saveSnapshotProgress`.
 */
export const _markSnapshotDone = mutation({
  args: {
    tableName: v.string(),
    snapshotTs: v.number(),
  },
  handler: async (ctx, { tableName, snapshotTs }) => {
    const row = await ctx.db
      .query("syncedTables")
      .withIndex("by_name", (q) => q.eq("name", tableName))
      .unique();
    if (!row) throw new Error(`Table not registered: ${tableName}`);
    await ctx.db.patch(row._id, {
      status: "running_delta",
      snapshotTs,
      lastAppliedAtMs: Date.now(),
      lastError: undefined,
    });
  },
});

// ============================================================================
// Delta stream — Fase 5
// ============================================================================

/**
 * Carga el progreso actual del stream de deltas para una tabla.
 * Si todavía no hay cursor delta guardado, devuelve `snapshotTs.toString()`
 * como cursor inicial (es el punto de entrada válido para `document_deltas`).
 */
export const _loadDeltaProgress = query({
  args: { tableName: v.string() },
  handler: async (ctx, { tableName }) => {
    const row = await ctx.db
      .query("syncedTables")
      .withIndex("by_name", (q) => q.eq("name", tableName))
      .unique();
    if (!row) throw new Error(`Table not registered: ${tableName}`);
    if (row.snapshotTs === undefined) {
      throw new Error(
        `Table ${tableName} has no snapshotTs — snapshot not complete`,
      );
    }

    const deltaCursor = await ctx.db
      .query("syncCursors")
      .withIndex("by_table_kind", (q) =>
        q.eq("tableName", tableName).eq("kind", "delta"),
      )
      .unique();

    return {
      columns: row.columns,
      // Primera llamada: cursor = String(snapshotTs) como exige el endpoint.
      cursor: deltaCursor?.cursor ?? String(row.snapshotTs),
      rowsApplied: row.rowsApplied,
    };
  },
});

/**
 * Persiste el cursor delta + count tras aplicar exitosamente un batch.
 * Upsert sobre `syncCursors(kind: "delta")` y actualiza `syncedTables`.
 */
export const _saveDeltaProgress = mutation({
  args: {
    tableName: v.string(),
    cursor: v.string(),
    rowsApplied: v.number(),
  },
  handler: async (ctx, { tableName, cursor, rowsApplied }) => {
    const row = await ctx.db
      .query("syncedTables")
      .withIndex("by_name", (q) => q.eq("name", tableName))
      .unique();
    if (!row) throw new Error(`Table not registered: ${tableName}`);

    await ctx.db.patch(row._id, {
      status: "running_delta",
      lastCursor: cursor,
      rowsApplied,
      lastAppliedAtMs: Date.now(),
      lastError: undefined,
    });

    const existing = await ctx.db
      .query("syncCursors")
      .withIndex("by_table_kind", (q) =>
        q.eq("tableName", tableName).eq("kind", "delta"),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { cursor });
    } else {
      await ctx.db.insert("syncCursors", {
        tableName,
        kind: "delta",
        cursor,
      });
    }
  },
});

/**
 * Lista tablas con `status: "running_delta"`. El tick las usa para (re)arrancar
 * el stream si se detuvo (idle o error transitorio).
 */
export const _listRunningDeltaNames = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("syncedTables")
      .withIndex("by_status", (q) => q.eq("status", "running_delta"))
      .collect();
    return rows.map((r) => r.name);
  },
});

/**
 * Marca la tabla en `error` con el mensaje. NO toca el cursor — la próxima
 * reanudación retoma desde el último cursor commiteado. El watchdog (Fase 6)
 * va a leer esto y decidir cuándo reintentar.
 */
export const _markError = mutation({
  args: {
    tableName: v.string(),
    error: v.string(),
  },
  handler: async (ctx, { tableName, error }) => {
    const row = await ctx.db
      .query("syncedTables")
      .withIndex("by_name", (q) => q.eq("name", tableName))
      .unique();
    if (!row) return; // Tabla des-registrada mid-flight: no rompemos el job.
    await ctx.db.patch(row._id, {
      status: "error",
      lastError: error.slice(0, 500),
      lastAppliedAtMs: Date.now(),
    });
  },
});

// ============================================================================
// Watchdog — Fase 6
// ============================================================================

/**
 * Devuelve el estado de TODAS las tablas en el formato que necesita el
 * watchdog para decidir qué acciones tomar.
 */
export const _listTablesForWatchdog = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("syncedTables").collect();
    return rows.map((r) => ({
      name: r.name,
      status: r.status,
      lastAppliedAtMs: r.lastAppliedAtMs,
      snapshotTs: r.snapshotTs,
      lastError: r.lastError,
    }));
  },
});

/**
 * Resetea una tabla a `pending` para forzar un re-snapshot completo.
 * Se usa cuando el watchdog detecta que la tabla fue borrada del destino.
 * Borra AMBOS cursores (snapshot y delta) para empezar de cero.
 */
export const _resetForReSnapshot = mutation({
  args: { tableName: v.string() },
  handler: async (ctx, { tableName }) => {
    const row = await ctx.db
      .query("syncedTables")
      .withIndex("by_name", (q) => q.eq("name", tableName))
      .unique();
    if (!row) return;

    await ctx.db.patch(row._id, {
      status: "pending",
      lastCursor: undefined,
      snapshotTs: undefined,
      lastError: undefined,
      rowsApplied: 0,
      lastAppliedAtMs: undefined,
    });

    // Borrar cursores de ambas fases.
    for (const kind of ["snapshot", "delta"] as const) {
      const cursor = await ctx.db
        .query("syncCursors")
        .withIndex("by_table_kind", (q) =>
          q.eq("tableName", tableName).eq("kind", kind),
        )
        .unique();
      if (cursor) await ctx.db.delete(cursor._id);
    }
  },
});
