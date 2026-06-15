/**
 * Cron tick del sync. Cada 10 segundos:
 *  - Arranca snapshots de tablas en `pending`.
 *  - Retoma el stream de deltas de tablas en `running_delta` que se detuvieron
 *    (idle o error transitorio). El watchdog completo (Fase 6) agrega backoff
 *    y detección de tabla borrada en destino.
 */
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Cast a `any`: el codegen de Convex genera `internal.snapshot` / `internal.delta`
// recién la próxima vez que se ejecute con backend (`bunx convex dev`).
crons.interval(
  "motherduck-sync tick",
  { seconds: 10 },
  (internal as any).snapshot._tick,
  {},
);

export default crons;
