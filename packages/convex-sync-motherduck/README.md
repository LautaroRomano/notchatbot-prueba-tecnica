# convex-sync-motherduck

Componente de Convex que replica tablas hacia MotherDuck o DuckDB local vía CDC (snapshot inicial + stream de deltas + fault tolerance).

---

## Lo que hace

1. **Snapshot inicial**: descarga todas las filas de una tabla vía `list_snapshot`, las inserta en DuckDB con `INSERT … ON CONFLICT DO UPDATE` (idempotente), y persiste un cursor durable en Convex. Si crashea a la mitad, retoma desde donde quedó.
2. **Stream de deltas**: sigue `document_deltas` con el cursor del snapshot. Aplica inserts, updates y deletes en una sola transacción por batch. El cursor avanza solo después del commit.
3. **Watchdog**: detecta tablas trabadas, errores con backoff vencido, y tablas borradas en el destino — y toma la acción correcta (restart snapshot, restart delta, reset + re-snapshot).
4. **Schema migrations**: columnas nuevas → `ALTER TABLE ADD COLUMN`. Cambio de tipo → re-snapshot completo.

---

## Restricciones de arquitectura

**Por qué la action `"use node"` no está acá:**

Convex no soporta `"use node"` dentro de componentes. Toda la lógica que toca DuckDB vive en el host app (`apps/demo/convex/`). Este componente expone métodos helper en `MotherduckSync` para que el host solo arme el `Destination` y delegue el procesamiento.

**Por qué está en un monorepo de tres paquetes:**

El bundler V8 de Convex sigue imports estáticos. `@duckdb/node-api` es un native addon — si cualquier archivo del componente lo importa (incluso `import type`), el bundle V8 revienta. La solución:

- `@notchat/destination-types` — solo tipos, sin native deps. Seguro de importar desde el componente.
- `@notchat/duck-destination` — implementación con `@duckdb/node-api`. Solo la action `"use node"` del host la importa, vía dynamic import opaco.
- `convex-sync-motherduck` (este paquete) — el componente puro V8.

---

## API pública

### `MotherduckSync(componentRef)`

Clase JS que el host instancia una vez.

```ts
import { MotherduckSync } from "convex-sync-motherduck";
export const sync = new MotherduckSync(components.motherduckSync as any);
```

**Métodos de configuración:**

| Método | Qué hace |
|---|---|
| `setConfig(ctx, config)` | Upsert del singleton de config (origin, deployKey, destination). Todos los campos opcionales. |
| `registerSyncedTables(ctx, tables)` | Upsert por nombre. Preserva cursor/snapshotTs/rowsApplied si la tabla ya existía. |
| `status(ctx)` | Devuelve `TableStatus[]` — una fila por tabla registrada. |

**Métodos para las actions del host:**

| Método | Qué hace |
|---|---|
| `getConfig(ctx)` | Lee el singleton de config (incluye secretos). |
| `listPendingTables(ctx)` | Nombres de tablas con `status: "pending"`. |
| `processOneSnapshotPage(ctx, tableName, destination)` | Procesa una página del snapshot. Devuelve `SnapshotResult`. |
| `processOneDeltaBatch(ctx, tableName, destination)` | Procesa un batch de deltas. Devuelve `DeltaResult`. |
| `listTablesForWatchdog(ctx)` | Estado completo de todas las tablas para `watchdogDecide`. |
| `resetForReSnapshot(ctx, tableName)` | Resetea a `pending`, limpia ambos cursores. Usado cuando el watchdog detecta tabla borrada o cambio de tipo. |
| `markError(ctx, tableName, error)` | Marca la tabla en `error` con mensaje. No toca el cursor. |

**Re-exports útiles:**

```ts
import { watchdogDecide, duckSqlType } from "convex-sync-motherduck";
```

---

## Result types

```ts
type SnapshotResult =
  | { kind: "more"; cursor: string }
  | { kind: "done"; snapshotTs: string }
  | { kind: "type_reset"; changedColumns: string[] };

type DeltaResult =
  | { kind: "more"; cursor: string; changesThisBatch: number }
  | { kind: "idle"; cursor: string }
  | { kind: "type_reset"; changedColumns: string[] };
```

`type_reset` indica que el esquema declarado difiere del esquema real en el destino (cambio de tipo, no columna nueva). El host debería llamar `resetForReSnapshot` y re-schedear el snapshot.

---

## Boilerplate del host

El integrador copia tres archivos a su `convex/`:

- `snapshot.ts` — actions `_processOnePage` y `_tick` (watchdog).
- `delta.ts` — action `_processDeltaBatch`.
- `crons.ts` — cron cada 10s llamando a `_tick`.

Ver ejemplos en `apps/demo/convex/` de este monorepo.

---

## Invariante de recovery

```
1. fetch page / batch from Convex streaming export
2. ensureTable (CREATE or ALTER)
3. BEGIN
   applyBatch / applyDeletes   ← idempotente vía ON CONFLICT
4. COMMIT
5. saveProgress(newCursor)     ← persiste cursor SOLO si commit fue OK
```

Crash entre 4 y 5: cursor no avanza → próxima iteración re-aplica el mismo batch → sin pérdida ni duplicación.
