/**
 * Lógica pura del watchdog. NO toca Convex ni DuckDB directamente —
 * recibe el estado de las tablas y el destino por inyección. Eso lo hace
 * testeable con fakes sin levantar ningún servicio.
 *
 * `watchdogDecide` analiza el estado de cada tabla y devuelve una lista de
 * acciones a ejecutar. El caller (`_tick` en el host) ejecuta esas acciones.
 *
 * Casos que cubre:
 *  - `pending` → arrancar snapshot.
 *  - `running_snapshot` trabado (sin progreso en N ms) → reintentar snapshot.
 *  - `running_delta` → comprobar si la tabla existe en el destino:
 *      · Si no existe → resetear y re-snapshotear.
 *      · Si existe pero el job se detuvo (sin progreso en M ms) → reiniciar delta.
 *  - `error` con backoff vencido → reintentar según la fase (snapshot o delta).
 *  - `idle` → tratar como pending (no debería ocurrir pero lo manejamos).
 *  - `paused` → nada.
 */

import type { Destination } from "@notchat/destination-types";

export type WatchdogTableState = {
  name: string;
  status:
    | "idle"
    | "pending"
    | "running_snapshot"
    | "running_delta"
    | "error"
    | "paused";
  /** Último avance del job (ms epoch). undefined si nunca arrancó. */
  lastAppliedAtMs: number | undefined;
  /** Presente si el snapshot completó. Ausente si nunca terminó. */
  snapshotTs: number | undefined;
  lastError: string | undefined;
};

export type WatchdogAction =
  | { kind: "start_snapshot"; tableName: string; reason: string }
  | { kind: "start_delta"; tableName: string; reason: string }
  | { kind: "reset_and_snapshot"; tableName: string; reason: string };

export type WatchdogConfig = {
  /** Umbral para considerar un snapshot trabado. Default: 120 000 ms. */
  stuckSnapshotMs?: number;
  /**
   * Tiempo mínimo de inactividad antes de reiniciar el delta (para que el tick
   * no duplique jobs que ya están en self-scheduling). Default: 15 000 ms.
   */
  deltaRestartMs?: number;
  /** Backoff mínimo antes de reintentar una tabla en `error`. Default: 30 000 ms. */
  errorRetryMs?: number;
};

/**
 * Analiza el estado de cada tabla y devuelve las acciones que el watchdog
 * debe ejecutar. Internamente consulta el destino para detectar tablas
 * borradas (`tableExists`).
 *
 * @param tables  - Estado actual de todas las tablas registradas.
 * @param destination - Solo necesitamos `tableExists`; si es `null` se salta
 *                      la comprobación de tabla borrada (útil cuando no hay
 *                      config de destino todavía).
 * @param nowMs   - Timestamp actual (inyectable para tests).
 */
export async function watchdogDecide(
  tables: WatchdogTableState[],
  destination: Pick<Destination, "tableExists"> | null,
  nowMs: number,
  config: WatchdogConfig = {},
): Promise<WatchdogAction[]> {
  const {
    stuckSnapshotMs = 120_000,
    deltaRestartMs = 15_000,
    errorRetryMs = 30_000,
  } = config;

  const actions: WatchdogAction[] = [];

  for (const t of tables) {
    const ageMs =
      t.lastAppliedAtMs !== undefined ? nowMs - t.lastAppliedAtMs : Infinity;

    switch (t.status) {
      case "pending":
      case "idle":
        actions.push({
          kind: "start_snapshot",
          tableName: t.name,
          reason: `status=${t.status}`,
        });
        break;

      case "running_snapshot":
        if (ageMs > stuckSnapshotMs) {
          actions.push({
            kind: "start_snapshot",
            tableName: t.name,
            reason: `stuck running_snapshot (${Math.round(ageMs / 1000)}s sin progreso)`,
          });
        }
        // Si no está trabado, el job de self-scheduling sigue vivo — no tocar.
        break;

      case "running_delta": {
        // Primero: ¿la tabla sigue existiendo en el destino?
        if (destination !== null) {
          const exists = await destination.tableExists(t.name);
          if (!exists) {
            actions.push({
              kind: "reset_and_snapshot",
              tableName: t.name,
              reason: "tabla eliminada del destino — re-snapshot necesario",
            });
            break;
          }
        }
        // La tabla existe. Reiniciar el job delta si se detuvo.
        if (ageMs > deltaRestartMs) {
          actions.push({
            kind: "start_delta",
            tableName: t.name,
            reason: `delta detenido (${Math.round(ageMs / 1000)}s sin progreso)`,
          });
        }
        break;
      }

      case "error": {
        if (ageMs <= errorRetryMs) break; // Backoff todavía activo.
        if (t.snapshotTs !== undefined) {
          // El snapshot completó antes del error → estaba en fase delta.
          actions.push({
            kind: "start_delta",
            tableName: t.name,
            reason: `retry tras error en delta (${t.lastError ?? "unknown"})`,
          });
        } else {
          // Nunca completó el snapshot.
          actions.push({
            kind: "start_snapshot",
            tableName: t.name,
            reason: `retry tras error en snapshot (${t.lastError ?? "unknown"})`,
          });
        }
        break;
      }

      case "paused":
        break;
    }
  }

  return actions;
}
