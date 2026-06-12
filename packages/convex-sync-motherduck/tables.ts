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
    }));
  },
});
