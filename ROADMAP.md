# Roadmap — `convex-sync-motherduck`

Plan de ejecución para la prueba técnica. Ordenado por dependencias: cada fase desbloquea la siguiente y deja algo demostrable.

---

## Fase 0 — Setup del entorno (½ día)

- [ ] Inicializar repo con `bun init` + TypeScript estricto (`strict: true`, `noUncheckedIndexedAccess: true`).
- [ ] Levantar **Convex self-hosted** local siguiendo https://docs.convex.dev/self-hosting (Docker compose del repo `convex-backend`).
- [ ] Verificar que `http://localhost:3210/api/streaming_export/list_snapshot` responde con un `CONVEX_DEPLOY_KEY` válido.
- [ ] Elegir destino: **DuckDB local** para desarrollo (`DUCKDB_PATH=./local.duckdb`), con switch a MotherDuck vía `MOTHERDUCK_TOKEN`.
- [ ] Scaffold Next.js (App Router) mínimo — sólo placeholder, la UI no es el foco.
- [ ] `.env.example` con todas las vars (`CONVEX_SELF_HOSTED_URL`, `CONVEX_DEPLOY_KEY`, `DUCKDB_PATH`, `MOTHERDUCK_TOKEN`, `MOTHERDUCK_DB_URL`).
- [ ] Runner de tests configurado (Vitest + `convex-test`).

**Entregable:** `bun dev` levanta Next.js, `bunx convex dev` se conecta al backend local, tests corren en vacío.

---

## Fase 1 — Schema de la demo NotChat CRM (½ día)

- [ ] Tablas Convex: `tenants`, `contacts`, `conversations`, `messages`, `attributes`, `contactAttributes`.
- [ ] `convex/seed.ts` idempotente (wipe-first o upsert por key natural):
  - 2–3 tenants
  - ≥500 contactos
  - ≥2000 mensajes
  - 5 tipos de atributo
  - ≥1000 contactAttributes
- [ ] Ejecutable como `bunx convex run seed:run`.
- [ ] Test: correr el seed dos veces, contar filas, deben coincidir.

**Entregable:** seed reproducible sobre deployment limpio.

---

## Fase 2 — Estructura del componente (½ día)

Esto es **una librería**, no código de la app. Modelar como [componente oficial de Convex](https://www.convex.dev/components).

- [ ] Carpeta `packages/convex-sync-motherduck/` con su propio `package.json` y `convex.config.ts`.
- [ ] Schema interno del componente:
  - `syncedTables` — `{ name, columns, status, lastCursor, snapshotTs, lastError, rowsApplied }`
  - `syncConfig` — singleton con `origin`, `deployKey`, `motherduckToken`, `destination`
  - `syncCursors` — cursor durable por tabla (separable de `syncedTables` para snapshot vs deltas)
- [ ] API pública del componente:
  - `setConfig` (mutation)
  - `registerSyncedTables(ctx, component, tables[])` (helper)
  - `status` (query) — devuelve estado por tabla
- [ ] Demo app consume el componente desde `convex/sync.ts`. **Cero lógica de sync en la app.**

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

## Fase 5 — Stream de deltas (1 día) ⭐ corte automático

- [ ] Action `runDeltas(tableName)` que arranca cuando snapshot está `done`:
  1. Cursor inicial = `snapshotTs`.
  2. `document_deltas?cursor=…` → aplicar inserts/updates/**deletes (tombstones)** en orden, en una sola tx → commit cursor.
  3. Si no hay cambios, esperar y reintentar (long-poll o sleep + tick).
- [ ] Deletes: `DELETE FROM tabla WHERE _id = ?` dentro de la misma tx.
- [ ] Backoff exponencial si MotherDuck/DuckDB falla. Cursor **no avanza** hasta commit exitoso.
- [ ] Test: secuencia insert→update→delete en Convex se refleja en DuckDB en el mismo orden.
- [ ] Test: re-aplicar el mismo batch dos veces deja el destino idéntico (idempotencia).
- [ ] Test: delete en Convex → fila desaparece en DuckDB.

**Entregable:** modificar una fila en Convex y verla cambiar en DuckDB en < 5s.

---

## Fase 6 — Self-heal / watchdog (½ día)

- [ ] Cron interno del componente cada N segundos:
  - Tablas registradas con `status: pending` y sin progreso → arrancar snapshot.
  - Tablas con `lastError` reciente y backoff vencido → reintentar.
  - **Detección de tabla borrada en destino**: si `tableExists` devuelve false pero el estado dice `done`, resetear cursor y re-snapshotear.
- [ ] Test: borrar la tabla en DuckDB → watchdog la reconstruye sin intervención.
- [ ] Logs estructurados (JSON) por cada acción del watchdog.

**Entregable:** sobrevive a un `DROP TABLE` manual en el destino.

---

## Fase 7 — Schema migrations (½ día)

- [ ] Al registrar tablas, comparar columnas declaradas vs schema actual en destino.
- [ ] **Aditivo:** columna nueva → `ALTER TABLE … ADD COLUMN`. Sin pérdida de datos.
- [ ] **Cambio de tipo:** marcar tabla para re-snapshot completo (documentar en README como decisión).
- [ ] Test: agregar columna en `registerSyncedTables` → aparece en DuckDB, datos viejos intactos.

**Entregable:** schema evoluciona sin downtime para casos aditivos.

---

## Fase 8 — Estado observable y logs (¼ día)

- [ ] Query `status` devuelve por tabla: `{ initialSync, lastCursor, lastError, rowsApplied, lastAppliedAt }`.
- [ ] Página en Next.js que renderiza el `status` (tabla simple, sin estilo) — sirve para debuggear en vivo durante la evaluación.
- [ ] Logs con nivel (`info`, `warn`, `error`) y contexto (tabla, cursor, batch size).

**Entregable:** abrir `/sync` y ver el estado de cada tabla en tiempo real.

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
