import { MotherduckSync } from "convex-sync-motherduck";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// La app huésped instancia el cliente con la referencia del componente
// (`components.motherduckSync` viene del codegen porque `convex.config.ts`
// hace `app.use(motherduckSync)`). Re-exponemos `status` como query
// pública para que la UI pueda mostrar el estado de la sincronización.
// `setConfig` y `register` son mutations públicas para bootstrap (CLI / SETUP).
//
// La lógica que toca DuckDB (action "use node" + cron) vive en
// `./snapshot.ts` y `./crons.ts`. Convex no soporta `"use node"` en
// componentes, así que el adapter (que es un native addon) no puede
// cargarse desde adentro del componente — la action vive acá.
const sync = new MotherduckSync(components.motherduckSync as any);

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

const columnSpec = v.object({
  name: v.string(),
  type: v.string(),
});

export const setConfig = mutation({
  args: {
    origin: v.optional(v.string()),
    deployKey: v.optional(v.string()),
    motherduckToken: v.optional(v.string()),
    destination: v.optional(destination),
  },
  handler: async (ctx, args) => {
    await sync.setConfig(ctx, args);
  },
});

export const register = mutation({
  args: {
    tables: v.array(
      v.object({
        name: v.string(),
        columns: v.array(columnSpec),
      }),
    ),
  },
  handler: async (ctx, { tables }) => {
    await sync.registerSyncedTables(ctx, tables);
  },
});

export const status = query({
  args: {},
  handler: (ctx) => sync.status(ctx),
});

/** Resetea todas las tablas a `pending` para forzar re-snapshot desde cero. */
export const resetAll = mutation({
  args: {},
  handler: async (ctx) => {
    const tables = await sync.status(ctx);
    for (const t of tables) {
      await ctx.runMutation(
        (components.motherduckSync as any).tables._resetForReSnapshot,
        { tableName: t.name },
      );
    }
    return { reset: tables.map((t) => t.name) };
  },
});
