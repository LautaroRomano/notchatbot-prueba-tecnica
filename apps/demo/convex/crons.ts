/**
 * Cron tick del sync. Cada 10 segundos arranca tablas en `pending`.
 * Boilerplate: copiar-pegar al integrar `convex-sync-motherduck` en tu
 * proyecto. El verdadero watchdog (reintentos con backoff, detección de
 * tabla borrada en destino) llega en Fase 6.
 */
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Cast a `any`: el codegen de Convex genera `internal.snapshot` recién la
// próxima vez que se ejecute con backend (`bunx convex dev`). Hasta entonces
// los tipos no conocen este módulo. En runtime la referencia es resolvida
// por nombre así que funciona igual.
crons.interval(
  "motherduck-sync tick",
  { seconds: 10 },
  (internal as any).snapshot._tick,
  {},
);

export default crons;
