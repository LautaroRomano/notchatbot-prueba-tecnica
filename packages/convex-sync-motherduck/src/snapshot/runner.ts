/**
 * Lógica pura del snapshot. NO toca Convex ni DuckDB directamente — recibe
 * todo lo que necesita por inyección de dependencias. Eso nos permite:
 *
 *  - Probar la orquestación con fakes (ver `runner.test.ts`) sin levantar
 *    Convex backend ni DuckDB real.
 *  - Mantener una única implementación que el wrapper de Convex llama por
 *    cada página (recordá: self-scheduling — una invocación = una página).
 *
 * Una llamada a `processSnapshotPage` representa **una página**:
 *   1. fetch list_snapshot con el cursor actual (o sin cursor si es la primera).
 *   2. Filtrar los documentos al schema declarado en `syncedTables` (modo
 *      ESTRICTO — descarta campos no declarados con warning).
 *   3. Abrir/asegurar la tabla destino con el spec actual (idempotente).
 *   4. Dentro de UNA transacción: `applyBatch`.
 *   5. Persistir el nuevo cursor en Convex.
 *   6. Si `hasMore: false`, persistir `snapshotTs` y marcar tabla
 *      como `running_delta` (listo para Fase 5).
 *
 * Devuelve si hay más páginas — el wrapper Convex usa esto para decidir si
 * `ctx.scheduler.runAfter(0, …)` schedulea otra iteración o si terminó.
 *
 * Invariante de recovery: el cursor se guarda DESPUÉS de que la tx del
 * destino haya commiteado. Si crasheamos entre paso 4 y 5, la próxima
 * iteración va a re-pedir la MISMA página (cursor no avanzó), el batch se
 * va a re-aplicar gracias a `ON CONFLICT (_id) DO UPDATE`, y todo converge.
 */

import type {
  ColumnDef,
  Destination,
  Row,
} from "@notchat/destination-types";
import {
  listSnapshot,
  type ListSnapshotPage,
  type SnapshotDocument,
} from "../streaming/listSnapshot";

export type SnapshotProgress = {
  /** Cursor commiteado más reciente (undefined si nunca arrancó). */
  cursor: string | undefined;
  /** Filas aplicadas acumuladas a lo largo del snapshot. */
  rowsApplied: number;
};

export type TableSpec = {
  name: string;
  columns: ReadonlyArray<ColumnDef>;
};

/**
 * I/O de cursor/estado contra Convex. El wrapper Convex implementa esto
 * llamando mutations internas; los tests pasan implementaciones in-memory.
 *
 * - `saveProgress` se llama tras cada página exitosa (cursor + count).
 * - `markSnapshotDone` se llama una vez al final (cuando hasMore: false).
 * - `logWarning` es para reportar campos no declarados, errores no fatales.
 */
export interface SnapshotIO {
  loadProgress(tableName: string): Promise<SnapshotProgress>;
  saveProgress(tableName: string, progress: SnapshotProgress): Promise<void>;
  markSnapshotDone(tableName: string, snapshotTs: number): Promise<void>;
  logWarning(message: string, ctx: Record<string, unknown>): void;
}

export type ProcessPageDeps = {
  origin: string;
  deployKey: string;
  table: TableSpec;
  destination: Destination;
  io: SnapshotIO;
  /** Override para tests — por defecto usa el client HTTP real. */
  fetchPage?: typeof listSnapshot;
};

export type ProcessPageResult =
  | { kind: "more"; cursor: string; rowsAppliedThisPage: number }
  | { kind: "done"; snapshotTs: number; rowsAppliedThisPage: number };

export async function processSnapshotPage(
  deps: ProcessPageDeps,
): Promise<ProcessPageResult> {
  const fetchPage = deps.fetchPage ?? listSnapshot;
  const { table, destination, io } = deps;

  // 1. Estado actual (cursor commiteado más reciente).
  const progress = await io.loadProgress(table.name);

  // 2. Pedimos la siguiente página al server.
  const fetchArgs: Parameters<typeof fetchPage>[0] = {
    origin: deps.origin,
    deployKey: deps.deployKey,
    tableName: table.name,
  };
  if (progress.cursor !== undefined) fetchArgs.cursor = progress.cursor;
  const page: ListSnapshotPage = await fetchPage(fetchArgs);

  // 3. Asegurar tabla destino (idempotente).
  await destination.ensureTable(table.name, table.columns);

  // 4. Filtrar al schema declarado (modo estricto).
  const declared = new Set(table.columns.map((c) => c.name));
  declared.add("_id");
  const rows = page.values.map((doc) =>
    coerceDocument(doc, declared, table.name, io),
  );

  // 5. Aplicar batch en una tx. Si revienta, el cursor no avanza.
  if (rows.length > 0) {
    await destination.withTransaction(() =>
      destination.applyBatch(table.name, rows),
    );
  }

  const rowsAppliedThisPage = rows.length;
  const newTotal = progress.rowsApplied + rowsAppliedThisPage;

  // 6. Cursor commiteado → ahora sí persistimos.
  await io.saveProgress(table.name, {
    cursor: page.cursor,
    rowsApplied: newTotal,
  });

  if (page.hasMore) {
    return { kind: "more", cursor: page.cursor, rowsAppliedThisPage };
  }

  // 7. Fin del snapshot. Necesitamos `snapshotTs` para arrancar deltas.
  // Si el server no lo devolvió (no debería), error visible — mejor reventar
  // que continuar a Fase 5 sin punto de partida válido.
  if (page.snapshotTs === undefined) {
    throw new Error(
      `list_snapshot terminó (hasMore=false) sin snapshotTs para tabla ${table.name}`,
    );
  }
  await io.markSnapshotDone(table.name, page.snapshotTs);
  return { kind: "done", snapshotTs: page.snapshotTs, rowsAppliedThisPage };
}

/**
 * Aplica el filtro estricto de columnas declaradas y normaliza el shape a
 * `Row` (lo que el destino espera). Campos no declarados se descartan con
 * un warning — el dev se entera de que hay drift entre Convex y su
 * `registerSyncedTables`.
 *
 * Decisión: NO inferimos tipos del documento. Si la columna está declarada
 * como `number` y el campo viene como string, la dejamos pasar; DuckDB va a
 * fallar el bind y eso aparecerá como error de batch — preferimos que
 * estalle visible a hacer coerciones silenciosas que enmascaren bugs.
 */
function coerceDocument(
  doc: SnapshotDocument,
  declared: Set<string>,
  tableName: string,
  io: SnapshotIO,
): Row {
  const out: Record<string, unknown> = {};
  const extras: string[] = [];
  for (const [key, value] of Object.entries(doc)) {
    if (declared.has(key)) {
      out[key] = value;
    } else if (key !== "_creationTime") {
      // `_creationTime` se descarta silencioso — siempre viene de Convex,
      // pero rara vez el dev lo declara como columna a replicar.
      extras.push(key);
    }
  }
  if (extras.length > 0) {
    io.logWarning(
      "Fields present in Convex document but not declared in registerSyncedTables — discarding",
      { tableName, extras },
    );
  }
  if (typeof out._id !== "string") {
    throw new Error(
      `coerceDocument: missing _id (string) in document for ${tableName}`,
    );
  }
  return out as Row;
}
