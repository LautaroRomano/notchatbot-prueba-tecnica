# Prueba Técnica: Sync Engine sobre Convex

## 🎯 Objetivo

Construir el componente `convex-sync-motherduck`: replica las tablas de Convex hacia **MotherDuck** (o DuckDB local) vía CDC. Snapshot inicial + stream de deltas + tolerancia a fallos.

La demo es **NotChat CRM**, un CRM B2C donde un negocio gestiona conversaciones de chat con sus consumidores finales. La demo es chica a propósito — el foco es la calidad del componente de sync, no la UI.

El desafío evalúa:

- Diseño de un **componente de Convex reutilizable** (no código de aplicación — librería que cualquiera podría instalar).
- Manejo correcto de **cursors, orden, idempotencia y reconexión** en un pipeline CDC.
- **Robustez ante fallos**: vamos a intentar romper tu sync (matarlo a la mitad, reiniciarlo, meterle datos durante un crash, cambiar el schema). Debe recuperarse.
- **Testing**: tests que prueban consistencia eventual entre Convex y el destino.

---

## 🧱 Stack obligatorio

- **bun** como gestor de paquetes
- **Next.js** (App Router) — sólo para hostear la UI de la demo
- **Convex** (local self-hosted recomendado — ver sección de setup)
- **MotherDuck** (free trial) o **DuckDB local** — DuckDB SQL en ambos casos
- **TypeScript** en modo estricto
- Runner de tests moderno (Vitest, Jest, Bun test o equivalente)
- **convex-test** (https://docs.convex.dev/testing/convex-test) para queries, mutations y la lógica de sync.

---

## 🛠️ Setup — algo importante de leer antes de arrancar

### Convex: **correr local, no cloud**

Convex expone dos endpoints HTTP de **Streaming Export** que son la base de toda la prueba:

- `list_snapshot` — paginación completa de una tabla con un cursor (para el backfill inicial).
- `document_deltas` — stream incremental de cambios desde un cursor (para los deltas).

Docs:
- Overview: https://docs.convex.dev/database/streaming-export
- API reference: https://docs.convex.dev/http-api/#streaming-export

**Importante:** estos endpoints **no están disponibles en el plan gratuito de Convex Cloud**. Son features de plan pago. Para esta prueba, te pedimos correr **Convex local** (self-hosted), que es gratis y tiene todos los endpoints habilitados:

- Repo: https://github.com/get-convex/convex-backend
- Self-hosting guide: https://docs.convex.dev/self-hosting

Con el backend local levantado, los endpoints viven en `http://localhost:3210/api/streaming_export/...` (puerto por defecto). El `CONVEX_DEPLOYMENT` apunta al backend local; las mutations/queries siguen funcionando exactamente igual que con la cloud.

### MotherDuck: free trial o DuckDB local

Dos opciones, equivalentes para esta prueba:

- **MotherDuck free trial** — https://motherduck.com/pricing/ — DuckDB hosteado, accesible vía HTTP. Es lo más cercano a "producción". El sync escribe via SQL sobre HTTP.
- **DuckDB local** — https://duckdb.org/ — corre como librería. Más simple para desarrollo, mismo dialecto SQL.

Si elegís DuckDB local, dejá la conexión configurable por env var (`DUCKDB_PATH=./local.duckdb`) para que podamos cambiar a MotherDuck con `MOTHERDUCK_TOKEN=...` al evaluar.

---

# `convex-sync-motherduck`

## 🔁 Qué tenés que construir

Un **componente oficial de Convex** (https://www.convex.dev/components) que replica tablas de Convex hacia MotherDuck/DuckDB. **Es una librería reutilizable**, no parte del código de la app. Cualquiera debería poder instalarlo en otro proyecto Convex y, con unas pocas líneas de configuración, tener su tabla replicada.

API esperada (orientativa, podés ajustar):

```ts
// convex.config.ts
import { defineApp } from "convex/server";
import motherduckSync from "convex-sync-motherduck/convex.config";

const app = defineApp();
app.use(motherduckSync);
export default app;
```

```ts
// convex/sync.ts
import { registerSyncedTables } from "convex-sync-motherduck";
import { components } from "./_generated/api";

export const register = mutation({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(components.motherduckSync.public.setConfig, {
      origin: process.env.CONVEX_SELF_HOSTED_URL!,
      deployKey: process.env.CONVEX_DEPLOY_KEY!,
      motherduckToken: process.env.MOTHERDUCK_TOKEN!,
      destination: process.env.MOTHERDUCK_DB_URL!,
    });
    return registerSyncedTables(ctx, components.motherduckSync, [
      { name: "contacts", columns: [...] },
      { name: "messages", columns: [...] },
      // ...
    ]);
  },
});
```

## 📋 Responsabilidades

1. **Registro de tablas** — el usuario del componente declara qué tablas sincronizar y con qué shape de columnas.
2. **Snapshot inicial** — para cada tabla registrada, paginar `list_snapshot` y escribir todos los rows a MotherDuck. Cursor durable: si el snapshot se interrumpe, debe poder retomar desde donde quedó.
3. **Stream incremental** — una vez que el snapshot terminó, consumir `document_deltas` continuamente. Aplicar inserts, updates y deletes en orden. Cursor durable.
4. **Self-heal / watchdog** — un cron interno que cada N segundos chequea: ¿hay tablas registradas que nunca empezaron el snapshot? ¿hay tablas que perdieron el cursor? ¿hay errores transitorios que vale la pena reintentar? Levantarlas.
5. **Estado observable** — una query pública del componente que devuelve por tabla `{ initialSync: "pending" | "running" | "done", lastCursor, lastError, rowsApplied }`. Sin esto no se puede debuggear nada.
6. **Idempotencia** — re-aplicar el mismo delta dos veces no produce duplicados, no rompe el cursor, no corrompe el destino.
7. **Deletes** — `document_deltas` te entrega tombstones. El destino tiene que reflejar el delete.

## 💡 Pistas / cosas a pensar antes de codear

**Sobre los endpoints de Convex:**

- `list_snapshot` te da rows en orden estable con un `cursor`. Cuando devuelve `hasMore: false`, terminaste el snapshot. **Guardá el `snapshotTs`** (el timestamp del snapshot) — lo necesitás para arrancar `document_deltas` desde ahí.
- `document_deltas` toma `cursor` (que en la primera llamada después del snapshot es el `snapshotTs`) y devuelve cambios ordenados con un nuevo `cursor` al final. **Es exactly-once por cursor pero at-least-once entre reconexiones** — la única forma de garantizar no-duplicación es que la aplicación a MotherDuck sea idempotente.
- Docs detalladas: https://docs.convex.dev/database/streaming-export

**Sobre idempotencia en MotherDuck:**

- Usá el `_id` de Convex como primary key en MotherDuck.
- Aplicá deltas con `INSERT … ON CONFLICT (_id) DO UPDATE SET …` (DuckDB lo soporta) o el patrón `DELETE + INSERT` dentro de una transacción.
- Los deletes se aplican con `DELETE FROM tabla WHERE _id = ?`.

**Sobre orden y atomicidad:**

- Un batch de deltas se aplica dentro de **una sola transacción** en MotherDuck. Si la transacción falla, el cursor no avanza. Próximo intento, mismo batch, idempotente, todo bien.
- Si el batch tiene N filas y aplicarlas tarda demasiado, partilo — pero el cursor sólo avanza cuando **todo el batch hasta ese cursor** está commiteado.

**Sobre recovery:**

- Si el proceso se mata a la mitad de un snapshot, al reiniciar tiene que retomar desde el último cursor guardado, **no desde cero**.
- Si el proceso se mata a la mitad de aplicar deltas, idem.
- Si MotherDuck está caído, el componente reintenta con backoff sin perder el cursor.
- Si alguien borra la tabla en MotherDuck a mano (porque sí, porque lo vamos a hacer en el test), el componente debería detectarlo y re-snapshotear automáticamente.

**Sobre schema migrations:**

- Caso 1: el usuario del componente agrega una columna nueva en el `registerSyncedTables(...)`. El componente debería detectar el cambio y hacer un `ALTER TABLE … ADD COLUMN` en MotherDuck.
- Caso 2: cambia el tipo de una columna existente. Acá no hay una respuesta perfecta — documentá tu decisión en el README (mi sugerencia: forzar re-snapshot completo de esa tabla).

## 🌱 Seed obligatorio

Tu repo debe incluir un **`convex/seed.ts`** que:

- Inserta una cantidad razonable de datos (al menos 500 contactos, 2000 mensajes, 5 tipos de atributo, 1000 contactAttributes, distribuidos entre 2-3 tenants).
- Es **idempotente** (correrlo dos veces no rompe nada — wipe-first o upsert).
- Es ejecutable como `bunx convex run seed:run`.

Nosotros lo vamos a correr al evaluar, esperá que lo ejecutemos en deployments limpios.

## 🧪 Tests (la parte más importante)

Sección obligatoria en el README: **"Qué decidí testear y qué no, y por qué"**.

Tests que **sí** queremos ver, usando `convex-test`:

- **Snapshot inicial completo**: con N filas sembradas, después del snapshot MotherDuck tiene exactamente N filas con los mismos valores.
- **Deltas aplicados en orden**: una secuencia de inserts/updates/deletes se refleja en MotherDuck en el mismo orden.
- **Idempotencia**: re-aplicar el mismo batch de deltas dos veces deja MotherDuck en el mismo estado.
- **Deletes**: borrar una fila en Convex la borra en MotherDuck.
- **Recovery after crash**: simular interrupción a la mitad de un snapshot — al reanudar, el resultado final es el mismo que un snapshot ininterrumpido.
- **Schema migration aditiva**: agregar una columna en el registro → la columna aparece en MotherDuck sin perder datos existentes.

Tests que podés dejar fuera pero justificá en el README (ej. tests de performance, tests de carga sostenida).

## 🤖 Cómo vamos a romper tu sync al evaluar

Para que lo tengas en cuenta. Vamos a:

1. **Matar el backend de Convex a la mitad de un snapshot** y verificar que al reiniciar retoma sin perder ni duplicar filas.
2. **Borrar la tabla destino en MotherDuck** y verificar que el self-heal la reconstruye.
3. **Tirar abajo MotherDuck** unos minutos durante un stream activo y verificar que cuando vuelve, los deltas pendientes se aplican en orden.
4. **Hacer un burst de writes** (1000 inserts/sec por 30 segundos) y verificar que el sync no pierde nada y eventualmente converge.
5. **Modificar una fila** en Convex mientras el snapshot está corriendo y verificar que el resultado final refleja el estado más reciente (no una versión vieja).
6. **Cambiar el schema** del registro (agregar columna) entre dos runs y verificar el `ALTER TABLE` automático.
7. **Correr el seed dos veces seguidas** y verificar que no se duplica nada.

Si tu sync sobrevive a todo esto, vas a estar muy bien posicionado.

## ✅ Criterios de evaluación

- **Diseño del componente** | API limpia, reutilizable, sin acoplamiento con la demo
- **Correctness** | Snapshot + deltas + deletes funcionando end-to-end contra MotherDuck/DuckDB
- **Robustez** | Sobrevive los escenarios de la sección anterior
- **Cursors y orden** | Manejo correcto de `snapshotTs` → `document_deltas`, durabilidad de cursors
- **Idempotencia** | Re-aplicar deltas no rompe nada
- **Tests** | Cobertura de lo que importa (sync correctness, recovery, idempotencia), no del coverage report
- **Seed** | Existe, es idempotente, corre limpio
- **Documentación** | README explica decisiones, trade-offs y cómo correrlo

**Corte automático:**

- Sin snapshot inicial funcionando → no avanza.
- Sin deltas incrementales funcionando → no avanza.
- Sin tests del sync → no avanza.
- Sin seed.ts ejecutable → no avanza.
- No se recupera de un crash a la mitad de un snapshot → no avanza.

---

# 📦 Entrega

Repo público en GitHub con README que incluya:

- Cómo levantar el entorno (Convex local + MotherDuck/DuckDB) — comandos exactos.
- Cómo correr el seed.
- Cómo correr los tests.
- **Decisiones de arquitectura**: cómo manejaste idempotencia, cómo manejaste schema migrations, cómo escalaría esto a 10x los datos.
- Sección **"Qué testeé y por qué"**.
- Sección **"Cómo se recupera de fallos"** — pasos concretos.
- Sección **"Uso de IA"** — qué hizo IA, qué hiciste vos.
- Diagrama (puede ser ASCII) del flujo: write → Convex → streaming export → sink → destino.

---

## 💡 Notas finales

- Un componente `convex-sync-motherduck` sólido, bien testeado, que sobreviva nuestros intentos de romperlo, es lo que estamos buscando.
- El componente es una **librería**. Si lo escribís como código de aplicación acoplado a la demo, perdés casi todos los puntos de diseño. Mirá los componentes oficiales de Convex (https://www.convex.dev/components) para entender la forma.
- **No hardcodees secretos**. Todo configurable por env vars o por `setConfig`.
- **Logueá razonablemente**. Cuando rompamos cosas para evaluar, querés que los logs nos digan qué está pasando.
- Si algo en este documento es ambiguo, decidí vos y documentalo en el README. Las decisiones bien argumentadas valen más que adivinar lo que queremos.
