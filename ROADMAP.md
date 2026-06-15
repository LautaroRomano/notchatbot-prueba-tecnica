# Roadmap — `convex-sync-motherduck`

Plan de ejecución para la prueba técnica. Ordenado por dependencias: cada fase desbloquea la siguiente y deja algo demostrable.

---

## Fase 0 — Setup del entorno (½ día) ✅

- [x] Inicializar repo con `bun init` + TypeScript estricto (`strict: true`, `noUncheckedIndexedAccess: true`).
- [x] Levantar **Convex self-hosted** local siguiendo https://docs.convex.dev/self-hosting (Docker compose del repo `convex-backend`).
- [x] Verificar que `http://localhost:3210/api/streaming_export/list_snapshot` responde con un `CONVEX_DEPLOY_KEY` válido.
- [x] Elegir destino: **DuckDB local** para desarrollo (`DUCKDB_PATH=./local.duckdb`), con switch a MotherDuck vía `MOTHERDUCK_TOKEN`.
- [x] Scaffold Next.js (App Router) mínimo — sólo placeholder, la UI no es el foco.
- [x] `.env.example` con todas las vars (`CONVEX_SELF_HOSTED_URL`, `CONVEX_DEPLOY_KEY`, `DUCKDB_PATH`, `MOTHERDUCK_TOKEN`, `MOTHERDUCK_DB_URL`).
- [x] Runner de tests configurado (Vitest + `convex-test`).

**Entregable:** `bun dev` levanta Next.js, `bunx convex dev` se conecta al backend local, tests corren en vacío.

---

## Fase 1 — Schema de la demo NotChat CRM (½ día) ✅

- [x] Tablas Convex: `tenants`, `contacts`, `conversations`, `messages`, `attributes`, `contactAttributes`.
- [x] `convex/seed.ts` idempotente (wipe-first o upsert por key natural):
  - 2–3 tenants
  - ≥500 contactos
  - ≥2000 mensajes
  - 5 tipos de atributo
  - ≥1000 contactAttributes
- [x] Ejecutable como `bunx convex run seed:run`.
- [x] Test: correr el seed dos veces, contar filas, deben coincidir.

**Entregable:** seed reproducible sobre deployment limpio.

---

## Fase 2 — Estructura del componente (½ día) ✅

Esto es **una librería**, no código de la app. Modelar como [componente oficial de Convex](https://www.convex.dev/components).

- [x] Carpeta `packages/convex-sync-motherduck/` con su propio `package.json` y `convex.config.ts`.
- [x] Schema interno del componente:
  - `syncedTables` — `{ name, columns, status, lastCursor, snapshotTs, lastError, rowsApplied }`
  - `syncConfig` — singleton con `origin`, `deployKey`, `motherduckToken`, `destination`
  - `syncCursors` — cursor durable por tabla (separable de `syncedTables` para snapshot vs deltas)
- [x] API pública del componente:
  - `setConfig` (mutation)
  - `registerSyncedTables(ctx, component, tables[])` (helper)
  - `status` (query) — devuelve estado por tabla
- [x] Demo app consume el componente desde `convex/sync.ts`. **Cero lógica de sync en la app.**

**Entregable:** `app.use(motherduckSync)` compila y `status` devuelve estado vacío.

---

## Fase 3 — Cliente DuckDB/MotherDuck (½ día) ✅

- [x] Adapter `Destination` con UNA implementación que cubre los dos backends:
  - DuckDB local → `DuckDBInstance.create(path)`
  - MotherDuck → `DuckDBInstance.create("md:<db>", { motherduck_token })`
- [x] Métodos: `ensureTable`, `applyBatch`, `applyDeletes`, `tableExists`, `countRows`, `dropTable`, `withTransaction`, `close`.
- [x] `applyBatch` usa `INSERT … ON CONFLICT (_id) DO UPDATE SET …` — idempotente por construcción.
- [x] `withTransaction` envuelve cada batch en `BEGIN/COMMIT/ROLLBACK`; `applyBatch`/`applyDeletes` fallan si se llaman fuera.
- [x] Tests del adapter aislados de Convex (`// @vitest-environment node`).

**Entregable:** 12 tests verdes sobre `:memory:`; cualquier consumidor llama `createDuckDestination(...)` → usa la interfaz `Destination`.

---

## Fase 4 — Snapshot inicial (1 día) ⭐ corte automático ✅ (parcial)

- [x] Cliente de `list_snapshot` con validación defensiva del shape.
- [x] Runner puro de UNA página con inyección de deps (Destination, IO).
- [x] Cursor persistido en `syncCursors`, count + status en `syncedTables`.
- [x] Action `"use node"` en el host con self-scheduling por página.
- [x] Cron tick (10s) que arranca `pending`.
- [x] Tests del runner con fakes: snapshot multi-página, recovery tras crash entre commit y saveProgress, schema estricto descarta extras, hasMore=false sin snapshotTs revienta.
- [ ] **Pendiente para Fase 9**: test end-to-end con Convex real + DuckDB real (500 contactos sembrados → snapshot → contar). Requiere backend Docker arriba.
- [ ] **Pendiente**: documentar el boilerplate del host (snapshot.ts + crons.ts) en el README al final.

**Entregable parcial:** la cadena snapshot → DuckDB existe y se puede verificar end-to-end al levantar Docker.

---

## Fase 5 — Stream de deltas (1 día) ⭐ corte automático ✅

- [x] Action `_processDeltaBatch(tableName)` que arranca cuando snapshot está `done`:
  1. Cursor inicial = `snapshotTs`.
  2. `document_deltas?cursor=…` → aplicar inserts/updates/**deletes (tombstones)** en orden, en una sola tx → commit cursor.
  3. Si no hay cambios (`idle`), el cron lo relanza en el siguiente tick.
- [x] Deletes: `DELETE FROM tabla WHERE _id = ?` dentro de la misma tx.
- [x] Cursor **no avanza** hasta commit exitoso (invariante de recovery).
- [x] Test: secuencia insert→update→delete en Convex se refleja en DuckDB en el mismo orden.
- [x] Test: re-aplicar el mismo batch dos veces deja el destino idéntico (idempotencia).
- [x] Test: delete en Convex → fila desaparece en DuckDB.

**Entregable:** 7 tests verdes; la cadena completa snapshot→delta existe.

---

## Fase 6 — Self-heal / watchdog (½ día) ✅

- [x] Función pura `watchdogDecide` (sin efectos secundarios, testeable sin backend):
  - Tablas `pending`/`idle` → start_snapshot.
  - `running_snapshot` atascada > 2 min → restart snapshot.
  - `running_delta` + tabla borrada en destino (`tableExists=false`) → reset_and_snapshot.
  - `running_delta` detenida > 15s → restart delta.
  - `error` con backoff vencido → reintentar por fase.
  - `paused` → no hace nada.
- [x] `_tick` en `snapshot.ts` reemplazado por watchdog completo con llamada a `watchdogDecide`.
- [x] Test: borrar la tabla en DuckDB → watchdog decide `reset_and_snapshot` sin intervención.
- [x] Logs estructurados (JSON) por cada acción del watchdog.

**Entregable:** 12 tests verdes; sobrevive a `DROP TABLE` manual en el destino.

---

## Fase 7 — Schema migrations (½ día) ✅

- [x] `columnTypes()` en `Destination` + `DuckDestination`: compara tipos declarados vs tipos reales en `information_schema`.
- [x] **Aditivo:** columna nueva → `ALTER TABLE … ADD COLUMN`. Sin pérdida de datos (ya estaba desde Fase 3; Fase 7 lo conecta al flujo de detección).
- [x] **Cambio de tipo:** `detectTypeChanges()` detecta el drift y devuelve `{ kind: "type_reset" }` — el host schedea re-snapshot completo.
- [x] Test: `columnTypes` devuelve el mapa correcto; cambio de tipo detectado.

**Entregable:** schema evoluciona sin downtime en casos aditivos; cambios de tipo se re-sincronizan sin pérdida.

---

## Fase 8 — Estado observable y logs (¼ día) ✅

- [x] Query `status` devuelve por tabla: `{ name, status, rowsApplied, snapshotTs, lastCursor, lastAppliedAtMs, lastError }`.
- [x] Página `/sync` en Next.js con `useQuery` — se actualiza en tiempo real vía Convex.
- [x] `StatusBadge` con colores por estado; cursor truncado a 20 chars; error en `title` para ver completo.
- [x] Logs estructurados (JSON) desde el watchdog.

**Entregable:** abrir `http://localhost:3000/sync` y ver el estado de cada tabla en tiempo real.

---

## Fase 9 — Suite de tests completa (1 día) ⭐ corte automático

Usando `convex-test`:

- [ ] Snapshot inicial completo (N filas → N filas iguales).
- [ ] Deltas en orden (insert/update/delete).
- [ ] Idempotencia de re-aplicación.
- [ ] Deletes propagados.
- [ ] Recovery tras crash en snapshot.
- [ ] Recovery tras crash en deltas.
- [ ] Schema migration aditiva.
- [ ] Tabla borrada en destino → self-heal.
- [ ] Seed corrido 2×, sin duplicados.
- [ ] Burst: simular 1000 writes/sec por 30s → converge.

Sección README **"Qué testeé y qué no, y por qué"** — performance/carga sostenida quedan fuera con justificación.

---

## Fase 10 — Documentación y entrega (½ día)

README con:

- [ ] Cómo levantar Convex local + DuckDB/MotherDuck (comandos exactos).
- [ ] Cómo correr el seed.
- [ ] Cómo correr los tests.
- [ ] **Decisiones de arquitectura**: idempotencia (`ON CONFLICT`), schema migrations (aditivo vs re-snapshot), escalabilidad a 10×.
- [ ] **Qué testeé y por qué.**
- [ ] **Cómo se recupera de fallos** (pasos concretos por escenario).
- [ ] **Uso de IA** — qué hizo la IA, qué hice yo.
- [ ] Diagrama ASCII del flujo: `write → Convex → streaming_export → sink → DuckDB/MotherDuck`.

---

## Resumen de cortes automáticos

Estos **deben** funcionar o la prueba no avanza:

1. Snapshot inicial funcional (Fase 4)
2. Deltas incrementales funcionales (Fase 5)
3. Tests del sync (Fase 9)
4. `seed.ts` ejecutable (Fase 1)
5. Recovery de crash a mitad de snapshot (Fase 4 + 9)

---

## Estimación total

~6–7 días de trabajo enfocado. Si tengo que recortar: la UI de la demo es lo primero que se simplifica; los tests y la robustez son innegociables.
