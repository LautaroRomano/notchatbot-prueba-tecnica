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
  }).index("by_name", ["name"]),

  syncConfig: defineTable({
    origin: v.string(),
    deployKey: v.string(),
    motherduckToken: v.string(),
    destination,
  }),

  syncCursors: defineTable({
    tableName: v.string(),
    kind: cursorKind,
    cursor: v.optional(v.string()),
  }).index("by_table_kind", ["tableName", "kind"]),
});
