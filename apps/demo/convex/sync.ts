import { MotherduckSync } from "convex-sync-motherduck";
import { components } from "./_generated/api";
import { query } from "./_generated/server";

// La app huésped instancia el cliente con la referencia del componente
// (`components.motherduckSync` viene del codegen porque `convex.config.ts`
// hace `app.use(motherduckSync)`). Toda la lógica de sync vive adentro del
// componente; acá sólo re-exponemos el `status` como query pública.
const sync = new MotherduckSync(components.motherduckSync as any);

export const status = query({
  args: {},
  handler: (ctx) => sync.status(ctx),
});
