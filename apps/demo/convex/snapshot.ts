"use node";

/**
 * Worker del snapshot — vive en el host app porque Convex no soporta
 * `"use node"` en componentes. Boilerplate mínimo que un dev que integre
 * `convex-sync-motherduck` copia tal cual:
 *  - `_processOnePage` procesa UNA página de snapshot y self-schedulea la
 *    siguiente si quedan más.
 *  - `_tick` lista tablas en `pending` y schedulea procesamiento por cada una.
 *  - `crons.ts` corre `_tick` cada N segundos.
 *
 * Toda la lógica de orquestación (HTTP a `list_snapshot`, filtrado de schema,
 * commit del cursor) vive en el componente. Acá solo construimos el
 * `Destination` y pasamos los handles del ActionCtx al cliente del componente.
 */

import { v } from "convex/values";
// NO importar `@notchat/duck-destination` estáticamente. El analizador de
// Convex bundlea este archivo en su pass de V8 (a pesar de "use node") y se
// rompe resolviendo los .node binaries del native addon. Lo cargamos vía
// `await import(path)` con `path` armado en runtime — esbuild no puede
// seguir esos imports, así que el bundle V8 queda limpio. En runtime
// Convex corre el handler en su runtime Node, donde require del .node anda.
import type {
  Destination,
  DuckDestinationOptions,
  SyncConfig,
} from "convex-sync-motherduck";
import { MotherduckSync } from "convex-sync-motherduck";
import { components, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const sync = new MotherduckSync(components.motherduckSync as any);

export const _processOnePage = internalAction({
  args: { tableName: v.string() },
  handler: async (ctx, { tableName }) => {
    const config = await sync.getConfig(ctx);
    if (!config || !config.origin || !config.deployKey || !config.destination) {
      await sync.markError(
        ctx,
        tableName,
        "syncConfig incomplete: origin, deployKey and destination are required",
      );
      return;
    }

    let dst: Destination;
    try {
      // Dynamic import opaco — ver nota arriba.
      const duckModulePath = ["@notchat", "duck-destination"].join("/");
      const duck = (await import(duckModulePath)) as typeof import("@notchat/duck-destination");
      dst = await duck.createDuckDestination(configToDuckOptions(config));
    } catch (err) {
      await sync.markError(
        ctx,
        tableName,
        `failed to open destination: ${errMsg(err)}`,
      );
      return;
    }

    try {
      const result = await sync.processOneSnapshotPage(ctx, tableName, dst);
      if (result.kind === "more") {
        await ctx.scheduler.runAfter(0, (internal as any).snapshot._processOnePage, {
          tableName,
        });
      } else {
        // Snapshot completo — arrancar el stream de deltas de inmediato.
        await ctx.scheduler.runAfter(0, (internal as any).delta._processDeltaBatch, {
          tableName,
        });
      }
    } catch (err) {
      await sync.markError(ctx, tableName, errMsg(err));
    } finally {
      await dst.close();
    }
  },
});

/**
 * Cron tick: arranca snapshots de tablas `pending` y retoma el delta stream
 * de tablas `running_delta` que se detuvieron (idle o error transitorio).
 * Fase 6 expande esto a watchdog completo con backoff y detección de tabla
 * borrada en destino.
 */
export const _tick = internalAction({
  args: {},
  handler: async (ctx) => {
    // Snapshots pendientes.
    const pending = await sync.listPendingTables(ctx);
    for (const name of pending) {
      await ctx.scheduler.runAfter(0, (internal as any).snapshot._processOnePage, {
        tableName: name,
      });
    }
    // Delta streams que necesitan retomarse.
    const runningDelta = await sync.listRunningDeltaTables(ctx);
    for (const name of runningDelta) {
      await ctx.scheduler.runAfter(0, (internal as any).delta._processDeltaBatch, {
        tableName: name,
      });
    }
  },
});

function configToDuckOptions(config: SyncConfig): DuckDestinationOptions {
  const d = config.destination!;
  if (d.kind === "duckdb_local") {
    return { kind: "duckdb_local", path: d.path };
  }
  if (!config.motherduckToken) {
    throw new Error(
      "MotherDuck destination requires motherduckToken in syncConfig",
    );
  }
  return {
    kind: "motherduck",
    database: d.databaseUrl,
    token: config.motherduckToken,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
