"use node";

/**
 * Worker del stream de deltas — vive en el host app por la misma razón que
 * snapshot.ts (Convex no soporta `"use node"` en componentes).
 *
 * `_processDeltaBatch` procesa UN batch de `document_deltas` y:
 *  - Si `more` Y destino es MotherDuck → self-schedulea la próxima iteración.
 *  - Si `more` Y destino es duckdb_local → retorna; el watchdog tick arranca
 *    el siguiente batch (evita escritores concurrentes en el mismo archivo).
 *  - Si `idle` → se detiene; el cron tick lo retoma en max 10 segundos.
 *
 * El cursor se guarda en Convex DESPUÉS de que el commit al destino sea
 * exitoso — mismo invariante de recovery que el snapshot.
 */

import { createRequire } from "module";
import { v } from "convex/values"; // v3
import type { Destination, DuckDestinationOptions, SyncConfig } from "convex-sync-motherduck";
import { MotherduckSync } from "convex-sync-motherduck";
import { components, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const sync = new MotherduckSync(components.motherduckSync as any);

export const _processDeltaBatch = internalAction({
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
      // CJS require via NODE_PATH — igual que snapshot.ts. ESM import() ignora
      // NODE_PATH para bare specifiers; createRequire() sí lo respeta.
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
      const result = await sync.processOneDeltaBatch(ctx, tableName, dst);
      // Para duckdb_local no auto-schedulear: DuckDB solo admite un escritor.
      // El watchdog tick (cada 10 s) arranca el siguiente batch, garantizando
      // que solo una tabla usa el archivo a la vez.
      const isLocalDuck = config.destination?.kind === "duckdb_local";
      if (result.kind === "more" && !isLocalDuck) {
        await ctx.scheduler.runAfter(
          0,
          (internal as any).delta._processDeltaBatch,
          { tableName },
        );
      } else if (result.kind === "type_reset" && !isLocalDuck) {
        // Cambio de tipo detectado — tabla volvió a pending, arrancar snapshot.
        console.log(JSON.stringify({
          level: "info",
          event: "type_reset_snapshot_restart",
          tableName,
          changedColumns: result.changedColumns,
        }));
        await ctx.scheduler.runAfter(
          0,
          (internal as any).snapshot._processOnePage,
          { tableName },
        );
      }
      // Si `idle` o duckdb_local: el watchdog tick retoma en ≤10 s.
    } catch (err) {
      await sync.markError(ctx, tableName, errMsg(err));
    } finally {
      await dst.close();
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
