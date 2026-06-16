# Guía de setup y prueba — paso a paso

Seguí este orden exacto. Cada paso depende del anterior.

---

## Arquitectura local

El puerto del API Convex depende del modo:

- **Solo `convex dev` (backend embebido)**: suele ser un puerto alto (p. ej. 3212) y lo escribe en `apps/demo/.env.local`.
- **Docker (`docker compose up -d backend`)**: API en **http://localhost:3210** (ver `docker-compose.yml`).

```
┌─────────────────────────────────────────────────────────────┐
│ Terminal A — convex:dev (o Docker backend)                  │
│  convex-local-backend / contenedor  →  ver .env.local       │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Terminal B — bun run dev                                    │
│  Next.js   →  http://localhost:3000                         │
│  (lee NEXT_PUBLIC_CONVEX_URL del .env.local del demo)       │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Sync pipeline (actions de Convex)                           │
│  Convex  →  DuckDB  ./data/duckdb/local.duckdb               │
└─────────────────────────────────────────────────────────────┘
```

> **Docker (recomendado en Windows)**. Levantá el backend con `docker compose up -d backend` desde la raíz del repo. En `docker-compose.yml`, `CONVEX_CLOUD_ORIGIN` / `CONVEX_SITE_ORIGIN` deben usar **`http://localhost:3210`** y **`http://localhost:3211`** (no `127.0.0.1`): en Windows la CLI y el navegador suelen resolver distinto `localhost` vs `127.0.0.1` y la **admin key** puede fallar con `BadAdminKey` si las URLs canónicas del backend apuntan al host equivocado.
>
> Generá la admin key: `docker compose exec -T backend ./generate_admin_key.sh` y copiá la línea `notchat-local|...` a `apps/demo/.env.local` y a `apps/demo/scripts/sync-set-config.local.json` (`origin` + `deployKey`). Opcional: duplicá esas dos variables en `apps/demo/convex-selfhosted.env` (gitignored) para `--env-file` con la CLI.
>
> **Solo `bun run convex:dev` sin Docker**: el backend embebido elige un puerto libre; no hace falta Docker para el flujo mínimo, pero en algunos entornos Windows el `start_push` del embebido puede fallar (500): en ese caso usá Docker como arriba.
>
> **Sync a `duckdb_local` (DuckDB nativo en actions) + backend en Docker**: hoy el contenedor self-hosted **no** expone el mismo `node_modules` que tu PC para resolver `@notchat/duck-destination`, y verás `Cannot find module '@notchat/duck-destination'`. Para **pasos 5–9 del sync a archivo `.duckdb` local**, usá **backend embebido**: en `apps/demo/.env.local` **no** definas `CONVEX_SELF_HOSTED_URL` ni `CONVEX_SELF_HOSTED_ADMIN_KEY` (solo `NEXT_PUBLIC_CONVEX_URL` / `SITE` apuntando al puerto que te imprima `convex dev`, p. ej. `http://127.0.0.1:3212`). En `sync-set-config` usá ese mismo `origin`, la key `anonymous-demo|...` de `apps/demo/.convex/local/default/config.json` y ruta Windows al `.duckdb`. Podés seguir usando Docker para el dashboard u otros servicios, pero **no** mezcles `convex dev` apuntando a `localhost:3210` con ese sync salvo que el destino sea MotherDuck u otra vía sin el addon local.

---

## Requisitos previos

- [bun](https://bun.sh) instalado (`bun --version` tiene que responder)
- [duckdb CLI](https://duckdb.org/docs/installation/) (opcional, para inspeccionar la DB al final)

---

## 1. Instalar dependencias

Desde la **raíz** del proyecto:

```powershell
bun install
```

Si ves `EBUSY`, `EACCES` o `EEXIST`:

```powershell
Remove-Item -Recurse -Force node_modules
Remove-Item -Recurse -Force apps\demo\node_modules
Remove-Item -Recurse -Force packages\convex-sync-motherduck\node_modules
Remove-Item -Recurse -Force packages\destination-types\node_modules
Remove-Item -Recurse -Force packages\duck-destination\node_modules
bun install
```

---

## 2. Iniciar el backend de Convex

En una **terminal que tiene que quedar abierta todo el tiempo**, desde la raíz:

```powershell
bun run convex:dev
```

Esto:
1. Levanta `convex-local-backend` en **http://127.0.0.1:3212**
2. Despliega todas las funciones de `apps/demo/convex/`
3. Genera el codegen en `apps/demo/convex/_generated/`
4. Crea `apps/demo/.env.local` con `NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3212`
5. Queda en modo watch (recarga al editar)

Cuando veas `✓ Convex functions ready` podés continuar.

---

## 3. Iniciar el frontend (Next.js)

En una **segunda terminal**, desde la raíz:

```powershell
bun run dev
```

El frontend queda en http://localhost:3000. Usa automáticamente el backend del
paso 2 porque `apps/demo/.env.local` ya tiene la URL correcta.

---

## 4. Correr los tests (sin backend)

En otra terminal, desde la raíz:

```powershell
bun run test
```

Tiene que salir `55 passed` en ~5s. Los tests son offline — no necesitan el backend.

```powershell
bun run typecheck    # verificar tipos — tiene que salir sin errores
```

---

## 5. Sembrar datos en Convex

Desde la raíz:

```powershell
bun run convex:run seed:run
```

Inserta: 3 tenants / 600 contactos / 2400 mensajes / ~1800 contactAttributes.

Es idempotente — podés correrlo más de una vez sin problema.

---

## 6. Configurar el destino del sync

### 6a. Obtener la admin key

La admin key del backend local se genera automáticamente al primer `convex dev`.
Está en:

```
apps/demo/.convex/local/default/config.json  →  campo "adminKey"
```

Ejemplo del archivo:
```json
{
  "ports": { "cloud": 3212, "site": 3213 },
  "adminKey": "anonymous-demo|01ccc8154e9665eb...",
  ...
}
```

Copiá el valor del campo `adminKey`.

### 6b. Crear el archivo de configuración

```powershell
Copy-Item apps\demo\scripts\sync-set-config.local.json.example apps\demo\scripts\sync-set-config.local.json
```

Abrí `apps/demo/scripts/sync-set-config.local.json` y reemplazá los campos:

```json
{
  "origin": "http://localhost:3210",
  "deployKey": "<adminKey del paso 6a>",
  "destination": {
    "kind": "duckdb_local",
    "path": "/data/local.duckdb"
  }
}
```

Si usás **solo** el backend embebido de `convex dev` (sin Docker) y las actions corren en tu Windows, usá ruta absoluta al `.duckdb` en el host, p. ej. `C:/Users/.../data/duckdb/local.duckdb`, y `origin` + `deployKey` del `apps/demo/.convex/local/default/config.json`.

> **Importante**: con **Docker** (`docker compose up -d backend`), las actions de Node corren **dentro del contenedor** Linux: el archivo montado por `docker-compose.yml` es **`/data/local.duckdb`** (no una ruta `C:/...`). `origin` debe ser **`http://localhost:3210`** y la key **`notchat-local|...`** de `docker compose exec -T backend ./generate_admin_key.sh`. Si mezclás embebido (`127.0.0.1:3212`, `anonymous-demo|...`) con un deploy contra **3210**, el streaming export y DuckDB no coinciden con el backend real.
>
> **Sólo** `origin`, `deployKey` y `destination` (y opcional `motherduckToken` si usás MotherDuck). No pegues acá `CONVEX_INSTANCE_SECRET` ni otras vars de Docker: el deploy falla con *Server Error* porque esas claves no existen en el esquema `syncConfig` del componente.

### 6c. Aplicar la configuración

Desde `apps/demo/`:

```powershell
cd apps\demo
bun run convex:run-json -- sync:setConfig ./scripts/sync-set-config.local.json
```

`*.local.json` está en `.gitignore` — no se commitea.

---

## 7. Registrar tablas para sincronizar

Desde `apps/demo/`:

```powershell
bun run convex:run-json -- sync:register ./scripts/sync-register.local.json.example
```

---

## 8. Ver el sync en tiempo real

Abrí **http://localhost:3000/sync** en el navegador.

En ≤10s vas a ver las tablas pasar por estos estados:
- `pending` → el cron todavía no arrancó
- `running_snapshot` → descargando filas de Convex a DuckDB
- `running_delta` → snapshot terminó, escuchando cambios en tiempo real

> **Para duckdb_local**, el watchdog procesa **una tabla por tick** (cada 10s)
> para evitar que múltiples writers abran el mismo archivo. Las 6 tablas
> pueden tardar ~60–120s en llegar todas a `running_delta`.

También podés ver el estado desde la raíz:

```powershell
bun run convex:run sync:status
```

---

## 9. Verificar los datos en DuckDB

Una vez que el estado sea `running_delta`, desde la raíz:

```powershell
duckdb ./data/duckdb/local.duckdb -c "SELECT count(*) FROM contacts;"
# tiene que dar 600

duckdb ./data/duckdb/local.duckdb -c "SELECT count(*) FROM messages;"
# tiene que dar 2400

duckdb ./data/duckdb/local.duckdb -c "SELECT * FROM contacts LIMIT 5;"
```

---

## 10. Probar los escenarios de fault recovery

### Self-heal: DROP TABLE

```powershell
duckdb ./data/duckdb/local.duckdb -c "DROP TABLE contacts;"
```

Esperá ≤10s y mirá http://localhost:3000/sync — el watchdog detecta que la tabla
no existe y la reconstruye sola.

### Recovery de error transitorio

Si una tabla queda en `error`, el watchdog la reintenta automáticamente después
de 30s de backoff.

### Idempotencia del seed

```powershell
bun run convex:run seed:run   # segunda corrida
bun run convex:run sync:status
duckdb ./data/duckdb/local.duckdb -c "SELECT count(*) FROM contacts;"
# sigue siendo 600
```

### Reset completo del sync (sin borrar datos de Convex)

```powershell
cd apps\demo
bun run convex:run sync:resetAll
```

Esto resetea todas las tablas a `pending` y re-corre snapshot + delta desde cero.
También hay que borrar el archivo DuckDB para evitar esquemas viejos:

```powershell
Remove-Item -Force data\duckdb\local.duckdb -ErrorAction SilentlyContinue
```

---

## Reset completo (volver al paso 0)

```powershell
Remove-Item -Recurse -Force data -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force apps\demo\.convex -ErrorAction SilentlyContinue
Remove-Item -Force apps\demo\.env.local -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force apps\demo\node_modules -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force packages\convex-sync-motherduck\node_modules -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force packages\destination-types\node_modules -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force packages\duck-destination\node_modules -ErrorAction SilentlyContinue
```

Después seguí desde el paso 1.

---

## Troubleshooting

| Síntoma | Fix |
|---|---|
| `EBUSY` / `EACCES` / `EEXIST` en `bun install` | Cerrar VS Code, borrar todos los `node_modules` (ver paso 1) y reinstalar |
| `MODULE_NOT_FOUND convex/bin/main.js` en `bun run convex:dev` | Bug de bun en Windows — ya resuelto con el wrapper `run-convex.mjs`; si persiste, borrar todos los `node_modules` y reinstalar |
| `[CONVEX Q(sync:status)] Server Error` en la UI | `bun run convex:dev` no está corriendo o no llegó a `✓ Convex functions ready` |
| `Failed to parse arguments as JSON` / comillas en Windows | Usá el helper `bun run convex:run-json` con un `.json` en disco (pasos 6–7) |
| `internal.snapshot does not exist` en typecheck | Correr `bun run convex:dev` con el backend arriba para regenerar el codegen |
| Sync se queda en `pending` después de 30s | Verificar que `sync:setConfig` se corrió con `origin` **http://localhost:3210** (Docker en Windows) y la admin key correcta de `docker compose exec backend ./generate_admin_key.sh` |
| `IO Error: Cannot open file ... already being utilized` | DuckDB no admite múltiples writers. Para `duckdb_local`, el watchdog serializa las tablas automáticamente. Si persiste, reiniciar `convex:dev`. |
| `document_deltas: cursor missing or not a string` | El backend self-hosted devuelve el cursor como número — ya corregido en el parser. |
| Tabla atascada en `error` sin progresar | El watchdog reintenta después de 30s. Si persiste, correr `sync:resetAll` |
| `Can't resolve 'convex/react'` en Next.js | Borrar `apps/demo/.next` y reiniciar `bun run dev` |
| `BadAdminKey` con Docker en **Windows** usando `127.0.0.1` | Usá `http://localhost:3210` en `CONVEX_SELF_HOSTED_URL`, `NEXT_PUBLIC_CONVEX_URL` y en `sync-set-config` → `origin` (el host y `127.0.0.1` pueden no ser el mismo listener). |
| `Cannot find module '@notchat/duck-destination'` con `convex dev` → **localhost:3210** (Docker) | El sync `duckdb_local` usa DuckDB nativo en actions; el contenedor self-hosted **no** resuelve `@notchat/duck-destination` del monorepo. Para DuckDB en archivo local usá **backend embebido** (sin `CONVEX_SELF_HOSTED_*` en `apps/demo/.env.local`) y `sync-set-config` alineado a ese `origin`/key (ver bloque *Arquitectura local*). Para quedarte en Docker, destino **MotherDuck** u otra vía sin el addon local. |
| Snapshots / DuckDB con Docker + `duckdb_local` | `convex.json` lista `@duckdb/*` como externos para Linux. En `sync-set-config` usá **`/data/local.duckdb`** y **`http://localhost:3210`** + key `notchat-local|...` coherentes con el contenedor (no mezclar con embebido `127.0.0.1:3212` / `anonymous-demo`). Si igual falla el módulo `@notchat/…`, el contenedor no monta ese paquete: usá embebido para este flujo. |
