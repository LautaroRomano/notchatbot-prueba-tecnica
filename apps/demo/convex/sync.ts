import { MotherduckSync } from "convex-sync-motherduck";
import { components } from "./_generated/api";
import { query } from "./_generated/server";

// La app huésped instancia el cliente con la referencia del componente
// (`components.motherduckSync` viene del codegen porque `convex.config.ts`
// hace `app.use(motherduckSync)`). Re-exponemos `status` como query
// pública para que la UI pueda mostrar el estado de la sincronización.
//
// La lógica que toca DuckDB (action "use node" + cron) vive en
// `./snapshot.ts` y `./crons.ts`. Convex no soporta `"use node"` en
// componentes, así que el adapter (que es un native addon) no puede
// cargarse desde adentro del componente — la action vive acá.
export const sync = new MotherduckSync(components.motherduckSync as any);

export const status = query({
  args: {},
  handler: (ctx) => sync.status(ctx),
});
