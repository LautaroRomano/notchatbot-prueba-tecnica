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

import { createRequire } from "module";
import { pathToFileURL } from "url";
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
import { MotherduckSync, watchdogDecide } from "convex-sync-motherduck";
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
      // createRequire resuelve el paquete usando NODE_PATH (seteado por
      // run-convex.mjs) y devuelve la ruta absoluta en disco. pathToFileURL
      // la convierte a file:// URL, que es lo que ESM de Node exige para
      // importar paquetes encontrados vía NODE_PATH.
      const _req = createRequire(import.meta.url);
      const duckPath = _req.resolve(["@notchat", "duck-destination"].join("/"));
      const duck = (await import(pathToFileURL(duckPath).href)) as typeof import("@notchat/duck-destination");
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
      } else if (result.kind === "done") {
        // Snapshot completo — arrancar el stream de deltas de inmediato.
        await ctx.scheduler.runAfter(0, (internal as any).delta._processDeltaBatch, {
          tableName,
        });
      } else {
        // type_reset: tabla vuelve a pending — re-arrancar snapshot desde cero.
        console.log(JSON.stringify({
          level: "info",
          event: "type_reset_snapshot_restart",
          tableName,
          changedColumns: result.changedColumns,
        }));
        await ctx.scheduler.runAfter(0, (internal as any).snapshot._processOnePage, {
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
 * Watchdog / cron tick — corre cada 10 segundos (ver crons.ts).
 *
 * Delega la lógica de decisión en `watchdogDecide` (puro, testeable).
 * Acá solo ejecutamos las acciones que devuelve: schedulear jobs y llamar
 * mutations de reset. Logs estructurados para que durante la evaluación
 * sea fácil ver qué está haciendo el watchdog.
 */
export const _tick = internalAction({
  args: {},
  handler: async (ctx) => {
    const config = await sync.getConfig(ctx);
    const tables = await sync.listTablesForWatchdog(ctx);

    if (tables.length === 0) return;

    // Abrir destino solo si hay config completa (para tableExists).
    let dst: Destination | null = null;
    if (config?.origin && config.deployKey && config.destination) {
      try {
        const _req = createRequire(import.meta.url);
        const duckPath = _req.resolve(["@notchat", "duck-destination"].join("/"));
        const duck = (await import(pathToFileURL(duckPath).href)) as typeof import("@notchat/duck-destination");
        dst = await duck.createDuckDestination(configToDuckOptions(config));
      } catch {
        // No podemos abrir el destino — el watchdog igualmente procesa
        // pending/error/stuck sin la comprobación de tableExists.
      }
    }

    try {
      const actions = await watchdogDecide(tables, dst, Date.now());

      for (const action of actions) {
        console.log(
          JSON.stringify({
            level: "info",
            event: "watchdog_action",
            kind: action.kind,
            table: action.tableName,
            reason: action.reason,
          }),
        );

        switch (action.kind) {
          case "start_snapshot":
            await ctx.scheduler.runAfter(
              0,
              (internal as any).snapshot._processOnePage,
              { tableName: action.tableName },
            );
            break;
          case "start_delta":
            await ctx.scheduler.runAfter(
              0,
              (internal as any).delta._processDeltaBatch,
              { tableName: action.tableName },
            );
            break;
          case "reset_and_snapshot":
            await sync.resetForReSnapshot(ctx, action.tableName);
            await ctx.scheduler.runAfter(
              0,
              (internal as any).snapshot._processOnePage,
              { tableName: action.tableName },
            );
            break;
        }
      }
    } finally {
      if (dst) await dst.close();
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
