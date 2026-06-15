# Guía de setup y prueba — paso a paso

Seguí este orden exacto. Cada paso depende del anterior.

---

## Requisitos previos

- [bun](https://bun.sh) instalado (`bun --version` tiene que responder)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) corriendo
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

Creá el archivo `.env.local` en la **raíz** del proyecto con este contenido:

```
CONVEX_DEPLOY_KEY=<la key que copiaste en el paso anterior>
CONVEX_SELF_HOSTED_ADMIN_KEY=<la misma key>
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210
NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3210
```

> `.env.local` ya está en `.gitignore` — no se commitea.

---

## 5. Conectar la app al backend

En una **terminal nueva** (dejala corriendo todo el tiempo), desde la raíz:

```powershell
bun run convex:dev
```

La primera corrida:
1. Se conecta al backend local
2. Regenera el codegen en `apps/demo/convex/_generated/`
3. Queda en modo watch

Cuando veas `✓ Convex functions ready` podés continuar.

---

## 6. Correr los tests (no necesita Docker)

En otra terminal, desde la raíz:

```powershell
bun run test
```

Tiene que salir `55 passed` en ~5s. No necesita el backend arriba — todos los tests son offline.

```powershell
bun run typecheck    # verificar tipos — tiene que salir sin errores
```

---

## 7. Sembrar datos en Convex

Desde la raíz:

```powershell
bun run convex:run seed:run
```

Inserta: 3 tenants / 600 contactos / 2400 mensajes / ~1800 contactAttributes.

Es idempotente — podés correrlo más de una vez sin problema.

---

## 8. Configurar el destino del sync

En **Windows**, pasar JSON inline suele fallar porque el shell reescribe las comillas. La forma estable es un archivo JSON:

1. Copiá el ejemplo:

```powershell
Copy-Item apps\demo\scripts\sync-set-config.local.json.example apps\demo\scripts\sync-set-config.local.json
```

2. Abrí `apps/demo/scripts/sync-set-config.local.json` y reemplazá `REEMPLAZAR_CON_LA_KEY_DEL_PASO_4` por tu deploy key.

3. Corré desde `apps/demo/`:

```powershell
cd apps\demo
bun run convex:run-json -- sync:setConfig ./scripts/sync-set-config.local.json
```

`*.local.json` está en `.gitignore` — no se commitea.

> El path `/data/local.duckdb` es adentro del container de Convex. El archivo real aparece en tu máquina en `./data/duckdb/local.duckdb`.

---

## 9. Registrar tablas para sincronizar

Desde `apps/demo/`:

```powershell
bun run convex:run-json -- sync:register ./scripts/sync-register.local.json.example
```

---

## 10. Ver el sync en tiempo real

Abrí **http://localhost:3000/sync** en el navegador.

En ≤10s vas a ver la tabla `contacts` pasar por estos estados:
- `pending` → el cron todavía no arrancó
- `running_snapshot` → descargando las 600 filas de Convex a DuckDB
- `running_delta` → snapshot terminó, escuchando cambios en tiempo real

También podés ver el estado desde la raíz:

```powershell
bun run convex:run sync:status
```

---

## 11. Verificar los datos en DuckDB

Una vez que el estado sea `running_delta`, desde la raíz:

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
bun run convex:run seed:run   # segunda corrida
bun run convex:run sync:status
duckdb ./data/duckdb/local.duckdb -c "SELECT count(*) FROM contacts;"
# sigue siendo 600
```

---

## Reset completo (volver al paso 0)

```powershell
docker compose down -v
Remove-Item -Recurse -Force convex-backend-data -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force data -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force apps\demo\node_modules -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force packages\convex-sync-motherduck\node_modules -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force packages\destination-types\node_modules -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force packages\duck-destination\node_modules -ErrorAction SilentlyContinue
Remove-Item -Force .env.local -ErrorAction SilentlyContinue
```

Después seguí desde el paso 1.

---

## Troubleshooting

| Síntoma | Fix |
|---|---|
| `EBUSY` / `EACCES` / `EEXIST` en `bun install` | Cerrar VS Code, borrar todos los `node_modules` (ver paso 1) y reinstalar |
| `MODULE_NOT_FOUND convex/bin/main.js` en `bun run convex:dev` | Bug de bun en Windows — ya resuelto con el wrapper `run-convex.mjs`; si persiste, borrar todos los `node_modules` y reinstalar |
| `Can't resolve 'convex/react'` en Next.js | `docker compose down -v && docker compose up -d` |
| `[CONVEX Q(sync:status)] Server Error` en la UI | `bun run convex:dev` no está corriendo o no llegó a `✓ Convex functions ready` |
| `Failed to parse arguments as JSON` / comillas en Windows | Usá el helper `bun run convex:run-json` con un `.json` en disco (pasos 8–9) |
| `bunx convex run` da error de conexión | Verificar que `bun run convex:dev` esté corriendo con `.env.local` cargado |
| `internal.snapshot does not exist` en typecheck | Correr `bun run convex:dev` con el backend arriba para regenerar el codegen |
| `curl http://localhost:3210/version` no responde | El backend todavía está iniciando — esperar 15–20s |
| Sync se queda en `pending` después de 30s | Verificar que `sync:setConfig` se corrió con la key correcta |
