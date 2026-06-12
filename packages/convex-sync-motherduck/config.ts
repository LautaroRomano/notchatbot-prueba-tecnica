import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Singleton: una sola fila en `syncConfig`. No hay UNIQUE declarativo en
// Convex, así que el invariante lo enforcea esta mutation (read-then-write).
//
// Todos los campos son opcionales en la mutation para permitir actualizaciones
// parciales (p. ej. setear sólo el destino durante el bootstrap, dejar los
// secretos para venir por env en una fase posterior).

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

export const set = mutation({
  args: {
    origin: v.optional(v.string()),
    deployKey: v.optional(v.string()),
    motherduckToken: v.optional(v.string()),
    destination: v.optional(destination),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("syncConfig").unique();
    if (existing) {
      await ctx.db.patch(existing._id, args);
      return existing._id;
    }
    return await ctx.db.insert("syncConfig", args);
  },
});

export const get = query({
  args: {},
  handler: async (ctx) => await ctx.db.query("syncConfig").unique(),
});
