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

---

## Conectar la app al backend local

Desde otra terminal, en el root:

```bash
bun run convex:dev
```

La primera corrida regenera todo el codegen (`apps/demo/convex/_generated/` y `packages/convex-sync-motherduck/_generated/`). Dejalo corriendo — quedan los watchers activos.

---

## Correr la app (Next.js)

```bash
bun run dev          # http://localhost:3000
```

---

## Correr los tests

```bash
bun run test         # corre todo (23 tests, ~2s)
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
│       └── convex/
│           ├── schema.ts              ← tablas del CRM
│           ├── seed.ts                ← seed idempotente
│           ├── sync.ts                ← instancia MotherduckSync, expone status
│           ├── snapshot.ts            ← "use node" action que toca DuckDB
│           └── crons.ts               ← tick del watchdog (cada 10s)
│
├── packages/
│   ├── convex-sync-motherduck/        ← EL COMPONENTE (la librería)
│   │   ├── convex.config.ts
│   │   ├── schema.ts, config.ts, tables.ts
│   │   ├── src/snapshot/runner.ts     ← lógica pura del snapshot
│   │   ├── src/streaming/             ← cliente HTTP de list_snapshot
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

## Troubleshooting

| Síntoma | Causa probable | Fix |
|---|---|---|
| `bunx convex dev` no se conecta | Backend Docker no respondió todavía | `docker compose logs backend` y esperar el healthcheck verde |
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
