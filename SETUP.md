# Guía de setup y prueba — paso a paso

Seguí este orden exacto. Cada paso depende del anterior.

---

## Requisitos previos

- [bun](https://bun.sh) instalado (`bun --version` tiene que responder)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) corriendo
- [duckdb CLI](https://duckdb.org/docs/installation/) (opcional, para inspeccionar la DB al final)

---

## 1. Instalar dependencias

```powershell
bun install
```

Si ves `EBUSY` o errores de caché:

```powershell
Remove-Item -Recurse -Force node_modules
bun install
```

---

## 2. Levantar Docker

```powershell
docker compose up -d
```

Esto descarga y levanta tres containers:
- `notchat-convex-backend` → API en http://localhost:3210
- `notchat-convex-dashboard` → UI en http://localhost:6791
- `notchat-next` → app Next.js en http://localhost:3000

**La primera vez tarda** — está descargando las imágenes (~500 MB en total). Las próximas veces arranca en segundos.

Verificá que el backend esté listo:

```powershell
curl http://localhost:3210/version
```

Tiene que responder con un JSON. Si da error, esperá 15–20s y reintentá.

---

## 3. Generar la admin key (solo la primera vez)

```powershell
docker compose exec backend ./generate_admin_key.sh
```

Vas a ver algo como:

```
Admin key: convex_admin_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Copiá esa key.

---

## 4. Crear el archivo de entorno

Creá el archivo `.env.local` en la raíz del proyecto con este contenido:

```
CONVEX_DEPLOY_KEY=<la key que copiaste en el paso anterior>
CONVEX_SELF_HOSTED_ADMIN_KEY=<la misma key>
```

> `.env.local` ya está en `.gitignore` — no se commitea.

---

## 5. Conectar la app al backend

En una **terminal nueva** (dejala corriendo todo el tiempo):

```powershell
bun run convex:dev
```

La primera corrida:
1. Se conecta al backend local
2. Regenera el codegen en `apps/demo/convex/_generated/` y `packages/convex-sync-motherduck/_generated/`
3. Queda en modo watch

Cuando veas `✓ Convex functions ready` podés continuar.

---

## 6. Correr los tests (no necesita Docker)

En otra terminal:

```powershell
bun run test
```

Tiene que salir `55 passed` en ~5s. No necesita el backend arriba — todos los tests son offline.

```powershell
bun run typecheck    # verificar tipos — tiene que salir sin errores
```

---

## 7. Sembrar datos en Convex

```powershell
bunx convex run seed:run
```

Inserta: 3 tenants / 600 contactos / 2400 mensajes / ~1800 contactAttributes.

Es idempotente — podés correrlo más de una vez sin problema.

---

## 8. Configurar el destino del sync

```powershell
bunx convex run sync:setConfig --args '{
  "origin": "http://host.docker.internal:3210",
  "deployKey": "<TU_CONVEX_DEPLOY_KEY>",
  "destination": { "kind": "duckdb_local", "path": "/data/local.duckdb" }
}'
```

Reemplazá `<TU_CONVEX_DEPLOY_KEY>` con la misma key del paso 4.

> El path `/data/local.duckdb` es adentro del container de Convex. El archivo real aparece en tu máquina en `./data/duckdb/local.duckdb`.

---

## 9. Registrar tablas para sincronizar

```powershell
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

---

## 10. Ver el sync en tiempo real

Abrí **http://localhost:3000/sync** en el navegador.

En ≤10s vas a ver la tabla `contacts` pasar por estos estados:
- `pending` → el cron todavía no arrancó
- `running_snapshot` → descargando las 600 filas de Convex a DuckDB
- `running_delta` → snapshot terminó, escuchando cambios en tiempo real

También podés ver el estado desde la terminal:

```powershell
bunx convex run sync:status
```

---

## 11. Verificar los datos en DuckDB

Una vez que el estado sea `running_delta`:

```powershell
duckdb ./data/duckdb/local.duckdb -c "SELECT count(*) FROM contacts;"
# tiene que dar 600

duckdb ./data/duckdb/local.duckdb -c "SELECT * FROM contacts LIMIT 5;"
```

---

## 12. Probar los escenarios de fault recovery

### Self-heal: DROP TABLE

```powershell
duckdb ./data/duckdb/local.duckdb -c "DROP TABLE contacts;"
```

Esperá ≤10s y mirá http://localhost:3000/sync — el watchdog detecta que la tabla no existe y la reconstruye sola.

### Recovery de crash del backend

Mientras el sync está corriendo:

```powershell
docker compose restart backend
```

Cuando el backend vuelva, el sync retoma desde el último cursor sin duplicar ni perder filas.

### Idempotencia del seed

```powershell
bunx convex run seed:run   # segunda corrida
bunx convex run sync:status
duckdb ./data/duckdb/local.duckdb -c "SELECT count(*) FROM contacts;"
# sigue siendo 600
```

---

## Troubleshooting

| Síntoma | Fix |
|---|---|
| `EBUSY: failed copying files` | `Remove-Item -Recurse -Force node_modules` y `bun install` |
| `Can't resolve 'convex/react'` en Next.js | `docker compose down -v && docker compose up -d` |
| `bunx convex run` da error de conexión | Verificar que `bun run convex:dev` esté corriendo con `.env.local` cargado |
| `internal.snapshot does not exist` en typecheck | Correr `bun run convex:dev` con el backend arriba para regenerar el codegen |
| `curl http://localhost:3210/version` no responde | El backend todavía está iniciando — esperar 15–20s |
| Sync se queda en `pending` después de 30s | Verificar que `setConfig` se corrió con la key correcta |
