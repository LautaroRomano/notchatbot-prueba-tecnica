# notchatbot — prueba técnica

Componente Convex `convex-sync-motherduck` que replica tablas hacia DuckDB / MotherDuck vía CDC. Incluye demo "NotChat CRM" como app de prueba.

📖 Para entender el proyecto en profundidad ver [`WALKTHROUGH.md`](./WALKTHROUGH.md). Para la bitácora del desarrollo ver [`PROGRESS.md`](./PROGRESS.md). Para el roadmap completo ver [`ROADMAP.md`](./ROADMAP.md).

---

## Requisitos

- [bun](https://bun.sh) `>= 1.3`
- [Docker](https://docs.docker.com/get-docker/) (para correr Convex self-hosted)
- [duckdb CLI](https://duckdb.org/docs/installation/) (opcional, para inspeccionar el destino)

---

## Setup inicial

```bash
# 1. Instalar deps
bun install

# 2. Copiar variables de entorno
cp .env.example .env.local
```

Editá `.env.local` — el `CONVEX_DEPLOY_KEY` se llena después de generar la admin key (siguiente paso).

---

## Levantar Convex self-hosted

```bash
docker compose up -d

# Verificar que respondió
curl http://localhost:3210/version

# Generar admin key (la primera vez)
docker compose exec backend ./generate_admin_key.sh
```

Copiá el output al `.env.local` como `CONVEX_DEPLOY_KEY` y `CONVEX_SELF_HOSTED_ADMIN_KEY`.

### URLs locales

| Servicio | URL |
|---|---|
| Convex API | http://localhost:3210 |
| Streaming Export | http://localhost:3210/api/streaming_export/ |
| HTTP Actions | http://localhost:3211 |
| Dashboard | http://localhost:6791 |
| Next.js (sync status) | http://localhost:3000/sync |

---

## Conectar la app al backend local

Desde otra terminal, en el root:

```bash
bun run convex:dev
```

La primera corrida regenera todo el codegen (`apps/demo/convex/_generated/` y `packages/convex-sync-motherduck/_generated/`). Dejalo corriendo — quedan los watchers activos.

---

## Correr la app (Next.js)

**Opción A — todo con Docker** (recomendado):

```bash
docker compose up -d   # levanta backend + dashboard + next en http://localhost:3000
```

**Opción B — dev server local** (para editar el frontend con HMR):

```bash
bun run dev          # http://localhost:3000
```

---

## Correr los tests

```bash
bun run test         # corre todo (55 tests, ~5s)
bun run test:watch   # watch mode
bun run typecheck    # tsc en componente + demo
```

---

## End-to-end: ver el sync funcionando contra DuckDB local

Asumiendo que ya tenés Docker arriba y `convex:dev` corriendo (pasos previos).

### 1. Sembrar la base

```bash
bunx convex run seed:run
```

Esto inserta 3 tenants / 600 contactos / 2400 mensajes / ~1800 contactAttributes. Es idempotente — correrlo dos veces deja el mismo estado.

### 2. Configurar el destino del sync

```bash
bunx convex run sync:setConfig --args '{
  "origin": "http://host.docker.internal:3210",
  "deployKey": "<TU_CONVEX_DEPLOY_KEY>",
  "destination": { "kind": "duckdb_local", "path": "/data/local.duckdb" }
}'
```

> El path `/data/local.duckdb` es desde adentro del contenedor de Convex. El archivo real aparece en el host en `./data/duckdb/local.duckdb` (volumen montado en `docker-compose.yml`).

### 3. Registrar tablas para sincronizar

```bash
bunx convex run sync:register --args '{
  "tables": [
    { "name": "contacts", "columns": [
      {"name":"_id","type":"string"},
      {"name":"tenantId","type":"string"},
      {"name":"externalId","type":"string"},
      {"name":"displayName","type":"string"}
    ]}
  ]
}'
```

### 4. Esperar el tick del cron (10s) y ver el estado

```bash
bunx convex run sync:status
```

Debería mostrar `status: "running_snapshot"` y luego `"running_delta"` cuando termine, con `rowsApplied: 600` y un `snapshotTs`.

### 5. Verificar contra DuckDB

```bash
duckdb ./data/duckdb/local.duckdb -c "SELECT count(*) FROM contacts;"
# count_star() = 600

duckdb ./data/duckdb/local.duckdb -c "SELECT * FROM contacts LIMIT 5;"
```

### 6. (Opcional) Probar idempotencia

```bash
bunx convex run seed:run  # corrida 2, mismos datos
bunx convex run sync:status  # rowsApplied debería seguir consistente
```

---

## Estructura del repo

```
.
├── apps/
│   └── demo/                          ← Next.js + Convex (demo NotChat CRM)
│       ├── app/
│       │   ├── page.tsx               ← home (enlace a /sync)
│       │   ├── sync/page.tsx          ← estado en tiempo real vía useQuery
│       │   ├── layout.tsx             ← ConvexClientProvider
│       │   └── ConvexClientProvider.tsx
│       └── convex/
│           ├── schema.ts              ← tablas del CRM
│           ├── seed.ts                ← seed idempotente
│           ├── sync.ts                ← instancia MotherduckSync, expone status
│           ├── snapshot.ts            ← "use node" actions: snapshot + watchdog tick
│           ├── delta.ts               ← "use node" action para el stream de deltas
│           └── crons.ts               ← tick del watchdog (cada 10s)
│
├── packages/
│   ├── convex-sync-motherduck/        ← EL COMPONENTE (la librería)
│   │   ├── convex.config.ts
│   │   ├── schema.ts, config.ts, tables.ts
│   │   ├── src/snapshot/runner.ts     ← lógica pura del snapshot
│   │   ├── src/delta/runner.ts        ← lógica pura del stream de deltas
│   │   ├── src/watchdog/index.ts      ← watchdog puro (sin Convex/DuckDB)
│   │   ├── src/streaming/             ← clientes HTTP (list_snapshot + document_deltas)
│   │   └── src/client/index.ts        ← MotherduckSync (cliente JS)
│   │
│   ├── destination-types/             ← solo tipos del Destination
│   └── duck-destination/              ← implementación con @duckdb/node-api
│
├── tests/component/                   ← tests del componente (fuera del paquete
│                                         para que el bundler de Convex no los toque)
│
├── docker-compose.yml                 ← Convex self-hosted
├── data/duckdb/                       ← volumen para el archivo .duckdb (gitignored)
└── convex-backend-data/               ← datos persistentes del backend (gitignored)
```

---

## Diagrama del flujo

```
  App Convex (NotChat CRM)
  insert / update / delete
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Convex self-hosted  (http://localhost:3210)                    │
│                                                                 │
│  GET /api/streaming_export/list_snapshot?tableName=&cursor=     │
│  GET /api/streaming_export/document_deltas?tableName=&cursor=   │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP  Authorization: Convex <deployKey>
             ┌─────────────┴──────────────┐
             │                            │
             ▼                            ▼
  ┌────────────────────┐       ┌────────────────────────┐
  │  snapshot runner   │       │     delta runner       │
  │  list_snapshot     │       │   document_deltas      │
  │  página por página │ ────► │  cursor = snapshotTs   │
  │  cursor durable    │       │  insert/replace/delete │
  └────────┬───────────┘       └────────────┬───────────┘
           │                                │
           └───────────────┬────────────────┘
                           │ withTransaction (BEGIN / COMMIT / ROLLBACK)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  DuckDB / MotherDuck                                            │
│                                                                 │
│  CREATE TABLE … (_id VARCHAR PRIMARY KEY, …)                   │
│  INSERT … ON CONFLICT (_id) DO UPDATE SET …  ← upserts        │
│  DELETE FROM … WHERE _id = ?                 ← tombstones      │
└─────────────────────────────────────────────────────────────────┘
           ▲
           │  cursor guardado en Convex DESPUÉS del COMMIT
           │  → si crasheás entre COMMIT y saveProgress,
           │    la próxima iteración re-aplica el mismo batch
           │    idempotentemente (ON CONFLICT no duplica)
           └──────────────────────────────────────────────────────
```

---

## Decisiones de arquitectura

### Idempotencia via `ON CONFLICT (_id) DO UPDATE`

Convex emite `document_deltas` con semántica *exactly-once* por cursor, pero *at-least-once* entre reconexiones. La única garantía robusta es que el **destino sea idempotente**.

Usamos `_id` de Convex como `PRIMARY KEY` en DuckDB. Cualquier `INSERT` que colisiona hace `UPDATE SET col = excluded.col` para todos los campos. Re-aplicar el mismo batch n veces deja el estado idéntico.

Alternativa descartada: `DELETE + INSERT` dentro de la misma transacción. Más explícita pero más cara (dos statements por fila). `ON CONFLICT` es el patrón idiomático en DuckDB/PostgreSQL y es suficiente.

### Schema migrations

**Columna nueva (caso aditivo):** `ensureTable` compara columnas declaradas con `information_schema.columns` y ejecuta `ALTER TABLE … ADD COLUMN` para las faltantes. Las filas existentes quedan con `NULL` en la columna nueva. Sin pérdida de datos, sin re-snapshot, sin downtime.

**Cambio de tipo de columna:** DuckDB no tiene `ALTER COLUMN TYPE` (requeriría recrear la tabla y un lock exclusivo). La opción implementada es **re-snapshot completo**: `resetForReSnapshot` limpia los cursores de snapshot y delta, el watchdog detecta el estado `pending` y arranca un snapshot nuevo. La decisión de tipo correcto se toma desde cero.

Alternativa descartada: ignorar el cambio de tipo. Llevaría a errores silenciosos en `bindByJsType` cuando el valor no sea casteable. Preferimos el error visible (`type_reset`) a la corrupción silenciosa.

### Escalabilidad a 10×

El cuello de botella a 10× de datos es el **snapshot inicial**, que hoy es secuencial (una página a la vez, una tabla a la vez). Para escalar:

- **Paralelizar snapshots por tabla**: el schema de `syncCursors` ya separa cursores por tabla — correr N snapshots simultáneos no requiere cambios en el componente, solo el scheduler del host.
- **Bulk load en snapshot**: reemplazar `INSERT ON CONFLICT` por `COPY` / `INSERT INTO … SELECT` para el bulk initial load. Mucho más rápido para millones de filas.
- **Incrementar page size**: `list_snapshot` acepta `numItems` — aumentar de 100 a 1000 reduce el número de round-trips.
- **MotherDuck en producción**: la conexión HTTP tiene mayor latencia que DuckDB local. A 10× se paralelizarían los writes por tabla. La arquitectura de tres paquetes ya permite swapear la implementación del `Destination` sin tocar el componente.

Los **deltas escalan bien** por diseño: `document_deltas` es incremental — el tamaño de cada batch crece con el write rate, no con el total de filas. El runner procesa un batch a la vez; si el batch se vuelve muy grande, se puede particionar el cursor antes de commitear.

---

## Qué testeé y por qué

### Lo que sí testeé

| Caso | Dónde | Por qué es crítico |
|---|---|---|
| Snapshot multi-página | `snapshot/runner.test.ts` + `integration/pipeline.test.ts` | El cursor debe avanzar correctamente entre páginas |
| Recovery tras crash (snapshot) | Ambos archivos | Es el corte automático de la prueba — falla aquí y no hay entrega |
| Recovery tras crash (delta) | `delta/runner.test.ts` + `integration/pipeline.test.ts` | Mismo invariante que snapshot; DuckDB real confirma el `ON CONFLICT` |
| Insert → update → delete en orden | Ambos runners | El orden importa; un delete de una fila que no existe es no-op silencioso |
| Idempotencia (snapshot y delta) | Ambos runners | At-least-once delivery requiere que re-aplicar sea inocuo |
| Schema estricto (descartar extras) | Ambos runners | Predecibilidad — el destino solo contiene lo declarado |
| Schema migration aditiva | `destination/duck.test.ts` + `integration/pipeline.test.ts` | `ALTER ADD COLUMN` con DuckDB real confirma que los datos viejos sobreviven |
| Detección de cambio de tipo | `destination/duck.test.ts` | Sin esta detección, `bindByJsType` falla silenciosamente |
| Self-heal (DROP TABLE) | `watchdog/index.test.ts` + `integration/pipeline.test.ts` | Con `tableExists` de DuckDB real — reproduce el escenario que la prueba va a ejecutar |
| Todos los estados del watchdog | `watchdog/index.test.ts` (12 casos) | La función pura `watchdogDecide` es la lógica de decisión central |
| Seed idempotente | `apps/demo/convex/seed.test.ts` | Corte automático de la prueba |

### Lo que no testeé y por qué

**Test e2e contra Convex real + DuckDB real**: requiere el backend Docker arriba. No quiero que `bun run test` dependa de Docker — en CI sin Docker los tests fallarían. La integración entre el layer de Convex y el layer de DuckDB está cubierta en dos capas: `convex-test` para las mutations, DuckDB real para el adapter. La brecha restante (el wiring entre ambos en las actions del host) es ~30 líneas de boilerplate.

**Burst sostenido (1000 writes/sec por 30s)**: es un test de performance/carga, no de correctness. El runner no tiene ningún límite artificial — el cuello de botella es la latencia de DuckDB/MotherDuck, que varía por entorno. El test de 500 filas en una página (`integration/pipeline.test.ts`) verifica que no hay límite práctico en el tamaño del batch. El burst sostenido requiere un backend real y tiempo de observación — queda fuera de una suite offline.

**Tests de la UI (`/sync` page)**: la página es un `useQuery` que renderiza un array. Testearla requiere un DOM y un servidor WebSocket de Convex. El riesgo de regresión es mínimo dado que la lógica está en el hook (que tiene su propio test layer en Convex) y no en el render.

**Tests de las actions del host** (`snapshot.ts`, `delta.ts`): son ~30 líneas de wiring que conectan el runner (testeado) con DuckDB (testeado) y el scheduler de Convex. Mockear el scheduler añade complejidad sin aumentar la confianza en la lógica de negocio, que está 100% en el runner.

---

## Cómo se recupera de fallos

### Escenario 1: crash en medio de un snapshot

```
Estado antes: status=running_snapshot, cursor=C1 en Convex, DuckDB tiene filas hasta C1.
```

1. El cron `_tick` vuelve a correr en ≤10s.
2. `watchdogDecide` ve `running_snapshot` con `lastAppliedAtMs` hace >120s → `start_snapshot`.
3. `_processOnePage` carga `cursor=C1` desde `syncCursors`.
4. Pide la misma página (desde C1) al endpoint.
5. Filas ya existentes en DuckDB → `ON CONFLICT` → `UPDATE` (no duplica).
6. Filas nuevas → `INSERT`.
7. Cursor avanza a C2, ciclo continúa hasta `hasMore=false`.

**Resultado:** cero pérdida de datos, cero duplicados.

### Escenario 2: crash en medio de un batch de deltas

```
Estado antes: cursor=D1 en Convex. DuckDB tiene los cambios hasta D1 commiteados.
Crash: entre el COMMIT de DuckDB y el saveProgress de Convex.
```

1. Cursor sigue siendo D1 en Convex (el `saveProgress` no llegó a ejecutarse).
2. `watchdogDecide` ve `running_delta` detenida >15s → `start_delta`.
3. `_processDeltaBatch` carga cursor=D1, re-fetchea el mismo batch.
4. `ON CONFLICT` y `DELETE` son idempotentes → mismo estado que sin crash.
5. `saveProgress` guarda D2 exitosamente.

**Resultado:** sin pérdida, sin duplicación.

### Escenario 3: DROP TABLE manual en DuckDB

1. `watchdogDecide` llama `dst.tableExists("contacts")` → `false`.
2. Status es `running_delta` → acción `reset_and_snapshot`.
3. `_tick` llama `sync.resetForReSnapshot`: limpia cursors de snapshot y delta en `syncCursors`, `status=pending`.
4. En el próximo tick, `_processOnePage` arranca snapshot desde cero.
5. En ≤10s la tabla existe de nuevo con todos los datos.

### Escenario 4: DuckDB / MotherDuck caído durante deltas

1. `_processDeltaBatch` lanza error → `sync.markError` guarda el mensaje, `status=error`.
2. `watchdogDecide` ve `error` con `lastAppliedAtMs` hace <30s → backoff activo → no hace nada.
3. A los 30s el backoff vence → `start_delta` (o `start_snapshot` si nunca terminó el snapshot).
4. DuckDB volvió → el batch pendiente se aplica y el stream continúa.

**El cursor nunca avanzó** durante el downtime — no hay ventana de datos perdidos.

### Escenario 5: burst de writes durante snapshot activo

`list_snapshot` usa un `snapshotTs` fijo — las páginas reflejan el estado *al momento de iniciar el snapshot*. Los writes que llegan mientras el snapshot corre no aparecen en las páginas del snapshot, pero sí en `document_deltas` a partir de ese `snapshotTs`.

Cuando el snapshot termina, el cursor de delta arranca en `snapshotTs` → captura **todos** los cambios post-snapshot. No hay ventana de datos perdidos.

### Escenario 6: cambio de schema (columna nueva o cambio de tipo)

**Columna nueva:** `ensureTable` detecta la columna faltante → `ALTER TABLE ADD COLUMN`. Los deltas que llegan con el campo nuevo se insertan correctamente. Sin downtime, sin re-snapshot.

**Cambio de tipo:** `detectTypeChanges` detecta el drift → `processOneDeltaBatch` devuelve `{ kind: "type_reset" }` → la action llama `resetForReSnapshot` y schedea un snapshot nuevo. La tabla se reconstruye desde Convex con el tipo correcto.

---

## Uso de IA

**Herramienta:** Claude Code (`sonnet-4-6`) a lo largo de todas las fases.

### Lo que hice yo (Lautaro)

**Fase 0 — Arquitectura inicial**

- Elegí Bun, Docker y la arquitectura basada en monorepo.
- Diagnostiqué la generación de archivos `.jsx` y `.d.ts` provocada por `composite: true` sin `outDir`.

**Fase 1.5 — Revisión del schema CRM**

- Revisé críticamente el schema CRM.
- Separé `openedAtMs` de `lastMessageAtMs`.
- Agregué el índice `by_tenant_recent`.
- Documenté las invariantes de unicidad.

**Fase 3 — Diseño del adaptador DuckDB/MotherDuck**

- Definí la estructura y las responsabilidades del adaptador.
- Validé el manejo de transacciones, la estrategia de `ON CONFLICT` y la serialización de datos.

**Fase 4 — Definición del schema y arquitectura**

- Definí un schema estricto: los campos no declarados se descartan mostrando un warning en lugar de aceptarse silenciosamente.
- Analicé y resolví el problema de arquitectura que llevó a dividir la solución en tres paquetes (`destination-types`, `duck-destination`, `convex-sync-motherduck`) y a utilizar imports dinámicos opacos.

**Fase 6 — Estrategia del watchdog**

- Validé la lógica del watchdog, sus estados posibles y la estrategia de recuperación ante errores y re-sincronizaciones.

**Fase 7 — Migraciones de schema**

- Revisé y aprobé la estrategia para detectar cambios en los tipos de columnas y reiniciar sincronizaciones cuando fuese necesario.

**Fase 8 — Interfaz `/sync`**

- Definí los criterios de visualización del dashboard, incluyendo estados, indicadores y experiencia de usuario.

**Todas las fases**

- Dirigí la implementación de cada fase.
- Validé las decisiones de arquitectura.
- Revisé críticamente el código generado.
- Ejecuté y probé los comandos contra el backend real.

### Lo que hizo la IA

**Fase 0–2 — Setup y estructura**

- Generó el scaffolding del monorepo.
- Configuró TypeScript en modo estricto.
- Implementó el schema del componente (`syncedTables`, `syncConfig`, `syncCursors`).
- Creó la API pública de `MotherduckSync`.
- Realizó tareas de housekeeping (`noEmit`, `.gitignore`, exclusión de tests del typecheck).

**Fase 3 — Adapter DuckDB/MotherDuck**

- Implementó `DuckDestination` con `ensureTable`, `applyBatch` (`ON CONFLICT`), `applyDeletes`, `withTransaction`, whitelist de identificadores, serialización JSON y 12 tests unitarios.

**Fase 4 — Snapshot inicial**

- Implementó el cliente HTTP `list_snapshot`.
- Creó el runner con inyección de dependencias.
- Implementó las mutations (`_loadSnapshotProgress`, `_saveSnapshotProgress`, `_markSnapshotDone`).
- Implementó la action `"use node"` y el cron correspondiente.

**Fase 5 — Stream de deltas**

- Implementó el cliente HTTP `document_deltas`.
- Creó el runner de deltas con separación entre upserts y tombstones.
- Implementó las mutations (`_loadDeltaProgress`, `_saveDeltaProgress`).
- Implementó la action `_processDeltaBatch`.

**Fase 6 — Watchdog**

- Implementó `watchdogDecide`.
- Implementó las mutations (`_listTablesForWatchdog`, `_resetForReSnapshot`).
- Reemplazó el tick básico por un watchdog completo con logs estructurados en JSON.

**Fase 7 — Schema migrations**

- Implementó `columnTypes()`, `detectTypeChanges()` y el manejo de `type_reset` tanto para snapshots como para deltas.

**Fase 8 — UI `/sync`**

- Implementó `ConvexClientProvider`, la página `/sync`, `StatusBadge`, estados de carga y estados vacíos.

**Fase 9 — Tests de integración**

- Implementó `tests/component/integration/pipeline.test.ts` con 7 pruebas conectando los runners contra DuckDB real (`:memory:`).

**Fase 10 — Documentación**

- Redactó `WALKTHROUGH`, `PROGRESS`, `ROADMAP` y este README.

## Troubleshooting

| Síntoma | Causa probable | Fix |
|---|---|---|
| `bunx convex dev` no se conecta | Backend Docker no respondió todavía | `docker compose logs backend` y esperar el healthcheck verde |
| Next.js container sale con error de módulo | node_modules del host (Windows) vs contenedor (Linux) | El volumen `next_node_modules` aísla los binarios — `docker compose down -v && docker compose up -d` reconstruye |
| `Failed to load url @notchat/duck-destination` en tests | Workspace deps no se hoistearon | `bun install` desde el root |
| `internal.snapshot does not exist` en typecheck | Codegen del demo viejo (sin backend cuando se ejecutó) | Correr `bun run convex:dev` con backend vivo para regenerar |
| `"use node" not supported in components` | Algún archivo del componente declara "use node" | El directive solo va en el host. Las actions con native deps viven en `apps/demo/convex/` |
| `Could not resolve "@duckdb/node-bindings-…/duckdb.node"` | Algún import estático de duckdb desde un archivo bundled para V8 | Convertir a dynamic import con path armado en runtime (ver `apps/demo/convex/snapshot.ts`) |

---

## Scripts útiles

```bash
bun run dev              # Next.js dev server
bun run convex:dev       # Convex codegen + push (deja watcher)
bun run convex:run       # Wrapper para `bunx convex run <fn>`
bun run test             # Vitest run
bun run test:watch       # Vitest watch
bun run typecheck        # tsc en componente + demo
```
