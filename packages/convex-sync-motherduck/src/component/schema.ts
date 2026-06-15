import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const columnDef = v.object({
  name: v.string(),
  type: v.string(),
});

const syncStatus = v.union(
  v.literal("idle"),
  v.literal("pending"),
  v.literal("running_snapshot"),
  v.literal("running_delta"),
  v.literal("error"),
  v.literal("paused"),
);

const destination = v.union(
  v.object({
    kind: v.literal("duckdb_local"),
    path: v.string(),
  }),
  v.object({
    kind: v.literal("motherduck"),
    databaseUrl: v.string(),
  }),
);

const cursorKind = v.union(v.literal("snapshot"), v.literal("delta"));

export default defineSchema({
  syncedTables: defineTable({
    name: v.string(),
    columns: v.array(columnDef),
    status: syncStatus,
    lastCursor: v.optional(v.string()),
    snapshotTs: v.optional(v.number()),
    lastError: v.optional(v.string()),
    rowsApplied: v.number(),
    // Timestamp del último avance (ms). El watchdog (Fase 6) usa esto para
    // detectar tablas trabadas: si una `running_snapshot` no avanzó en N
    // segundos, asume crash y la re-arranca.
    lastAppliedAtMs: v.optional(v.number()),
  })
    .index("by_name", ["name"])
    .index("by_status", ["status"]),

  // Singleton — el invariante "una sola fila" se enforcea en `config.set`
  // (no hay UNIQUE declarativo en Convex). Todos los campos opcionales
  // para permitir setConfig parcial durante el bootstrap; `motherduckToken`
  // sólo aplica cuando `destination.kind === "motherduck"`.
  syncConfig: defineTable({
    origin: v.optional(v.string()),
    deployKey: v.optional(v.string()),
    motherduckToken: v.optional(v.string()),
    destination: v.optional(destination),
  }),

  syncCursors: defineTable({
    tableName: v.string(),
    kind: cursorKind,
    cursor: v.optional(v.string()),
  }).index("by_table_kind", ["tableName", "kind"]),
});
