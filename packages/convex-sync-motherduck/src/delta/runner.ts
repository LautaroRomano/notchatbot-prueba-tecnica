/**
 * Lógica pura del stream de deltas. NO toca Convex ni DuckDB directamente —
 * recibe todo por inyección de dependencias (mismo patrón que snapshot/runner.ts).
 *
 * Una llamada a `processDeltaBatch` representa UN batch del endpoint:
 *   1. Carga el cursor actual desde el IO (Convex).
 *   2. Llama `document_deltas` con ese cursor.
 *   3. Asegura que la tabla existe en el destino (idempotente).
 *   4. Dentro de UNA transacción: applyBatch (inserts/updates) + applyDeletes.
 *   5. Persiste el nuevo cursor DESPUÉS del commit (invariante de recovery).
 *   6. Devuelve `{ kind: "more" }` si quedan más cambios, o `{ kind: "idle" }`
 *      si alcanzamos el live-head.
 *
 * Idempotencia: re-aplicar el mismo batch produce el mismo estado porque:
 *   - Inserts/updates usan `ON CONFLICT (_id) DO UPDATE` en el destino.
 *   - Deletes son `DELETE WHERE _id = ?` — borrar lo ya borrado es no-op.
 *   - El cursor no avanza hasta que el commit exitoso completa → si crasheamos
 *     entre el COMMIT del destino y el saveProgress, la próxima iteración
 *     re-fetchea el mismo batch y lo aplica idempotentemente.
 */

import type { ColumnDef, Destination, Row } from "@notchat/destination-types";
import {
  documentDeltas,
  type DeltaEntry,
  type DeltaPage,
} from "../streaming/documentDeltas";

export type DeltaProgress = {
  /** Cursor commiteado más reciente. Primera vez = String(snapshotTs). */
  cursor: string;
  /** Filas netas aplicadas (acumulado; inserts suman, deletes restan). */
  rowsApplied: number;
};

export type TableSpec = {
  name: string;
  columns: ReadonlyArray<ColumnDef>;
};

/**
 * I/O de cursor/estado contra Convex. Implementado por el wrapper del componente;
 * en tests lo reemplazamos con un fake in-memory.
 */
export interface DeltaIO {
  loadProgress(tableName: string): Promise<DeltaProgress>;
  saveProgress(tableName: string, progress: DeltaProgress): Promise<void>;
  logWarning(message: string, ctx: Record<string, unknown>): void;
}

export type ProcessDeltaDeps = {
  origin: string;
  deployKey: string;
  table: TableSpec;
  destination: Destination;
  io: DeltaIO;
  /** Override para tests — por defecto usa el client HTTP real. */
  fetchBatch?: typeof documentDeltas;
};

export type ProcessDeltaResult =
  | { kind: "more"; cursor: string; changesThisBatch: number }
  | { kind: "idle"; cursor: string };

export async function processDeltaBatch(
  deps: ProcessDeltaDeps,
): Promise<ProcessDeltaResult> {
  const fetchBatch = deps.fetchBatch ?? documentDeltas;
  const { table, destination, io } = deps;

  // 1. Cursor commiteado más reciente.
  const progress = await io.loadProgress(table.name);

  // 2. Pedimos el siguiente batch al server.
  const page: DeltaPage = await fetchBatch({
    origin: deps.origin,
    deployKey: deps.deployKey,
    tableName: table.name,
    cursor: progress.cursor,
  });

  // 3. Asegurar tabla destino (idempotente — CREATE o ALTER aditivo).
  await destination.ensureTable(table.name, table.columns);

  // 4. Separar inserts/updates de deletes.
  const declared = new Set(table.columns.map((c) => c.name));
  declared.add("_id");

  const rowsToUpsert: Row[] = [];
  const idsToDelete: string[] = [];

  for (const entry of page.values) {
    if (entry.action === "delete") {
      idsToDelete.push(entry.id);
    } else {
      // insert o replace — ambos usan upsert en el destino.
      if (!entry.fields) {
        io.logWarning(
          "Delta entry with action insert/replace has no fields — skipping",
          { tableName: table.name, id: entry.id, action: entry.action },
        );
        continue;
      }
      rowsToUpsert.push(
        coerceDeltaDocument(
          entry.fields as Record<string, unknown>,
          entry.id,
          declared,
          table.name,
          io,
        ),
      );
    }
  }

  // 5. Aplicar todo en UNA transacción. Si revienta, el cursor no avanza.
  const hasChanges = rowsToUpsert.length > 0 || idsToDelete.length > 0;
  if (hasChanges) {
    await destination.withTransaction(async () => {
      if (rowsToUpsert.length > 0) {
        await destination.applyBatch(table.name, rowsToUpsert);
      }
      if (idsToDelete.length > 0) {
        await destination.applyDeletes(table.name, idsToDelete);
      }
    });
  }

  const changesThisBatch = rowsToUpsert.length + idsToDelete.length;

  // 6. Cursor commiteado → ahora sí persistimos.
  const newRowsApplied = progress.rowsApplied + rowsToUpsert.length - idsToDelete.length;
  await io.saveProgress(table.name, {
    cursor: page.cursor,
    rowsApplied: Math.max(0, newRowsApplied),
  });

  if (page.hasMore) {
    return { kind: "more", cursor: page.cursor, changesThisBatch };
  }
  return { kind: "idle", cursor: page.cursor };
}

/**
 * Aplica el filtro estricto de columnas declaradas sobre un documento de delta.
 * Mismo comportamiento que en el snapshot: descarta extras con warning, `_creationTime` silencioso.
 */
function coerceDeltaDocument(
  doc: Record<string, unknown>,
  entryId: string,
  declared: Set<string>,
  tableName: string,
  io: DeltaIO,
): Row {
  const out: Record<string, unknown> = {};
  const extras: string[] = [];
  for (const [key, value] of Object.entries(doc)) {
    if (declared.has(key)) {
      out[key] = value;
    } else if (key !== "_creationTime") {
      extras.push(key);
    }
  }
  if (extras.length > 0) {
    io.logWarning(
      "Fields present in delta but not declared in registerSyncedTables — discarding",
      { tableName, extras },
    );
  }
  // Garantizar _id aunque `fields` no lo incluya (Convex siempre lo manda,
  // pero por seguridad usamos también el `id` de nivel raíz de la entrada.
  if (typeof out._id !== "string") {
    out._id = entryId;
  }
  return out as Row;
}
