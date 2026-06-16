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
import { v } from "convex/values";
// NO importar `@notchat/duck-destination` estáticamente. El analizador de
// Convex bundlea este archivo en su pass de V8 (a pesar de "use node") y se
// rompe resolviendo los .node binaries del native addon.
//
// Usamos `createRequire` para cargar el paquete vía CJS require() en lugar
// de ESM import(). La diferencia clave: CJS require() SOPORTA NODE_PATH,
// que el runtime de Convex local SÍ propaga a los workers (a diferencia de
// variables de entorno custom como CONVEX_DUCK_PATH). El paquete se compiló
// como CJS (.cjs) para que Node.js lo acepte aunque el package tenga
// `"type": "module"`. esbuild no puede seguir `_req(computed_string)` así
// que el bundle V8 queda limpio del native addon.
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
      // CJS require via NODE_PATH — ver nota arriba.
      const _req = createRequire(import.meta.url);
      const duck = _req(["@notchat", "duck-destination"].join("/")) as typeof import("@notchat/duck-destination");
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
      // Para duckdb_local los snapshots sí se auto-schedulean (solo 1 corre a
      // la vez porque el watchdog limita a 1 action por tick para running_snapshot).
      // Pero el primer batch de delta NO se schedulea aquí: dejamos que el
      // watchdog lo dispare para evitar que coincida con el snapshot de otra tabla.
      const isLocalDuck = config.destination?.kind === "duckdb_local";
      if (result.kind === "more") {
        await ctx.scheduler.runAfter(0, (internal as any).snapshot._processOnePage, {
          tableName,
        });
      } else if (result.kind === "done" && !isLocalDuck) {
        // Snapshot completo — arrancar el stream de deltas de inmediato (cloud).
        await ctx.scheduler.runAfter(0, (internal as any).delta._processDeltaBatch, {
          tableName,
        });
      } else if (result.kind === "done") {
        // duckdb_local: el watchdog tick arranca el delta en el próximo ciclo.
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
        const duck = _req(["@notchat", "duck-destination"].join("/")) as typeof import("@notchat/duck-destination");
        dst = await duck.createDuckDestination(configToDuckOptions(config));
      } catch {
        // No podemos abrir el destino — el watchdog igualmente procesa
        // pending/error/stuck sin la comprobación de tableExists.
      }
    }

    try {
      // For local DuckDB, only start ONE table per tick — DuckDB single-writer
      // limit means concurrent "use node" subprocesses can't open the same file.
      // delta.ts no se auto-schedulea para duckdb_local; el watchdog maneja
      // todo. deltaRestartMs = 11 s garantiza que el tick siguiente siempre
      // retoma una tabla en running_delta (cron interval = 10 s).
      const isLocalDuck = config?.destination?.kind === "duckdb_local";
      const watchdogCfg = isLocalDuck ? { deltaRestartMs: 11_000 } : {};
      const actions = await watchdogDecide(tables, dst, Date.now(), watchdogCfg);
      const actionsToRun = isLocalDuck ? actions.slice(0, 1) : actions;

      for (const action of actionsToRun) {
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
