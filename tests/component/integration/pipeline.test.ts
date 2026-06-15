// @vitest-environment node
//
// Pruebas de integración: runner de snapshot + runner de delta + DuckDB real
// (`:memory:`). Se ejercita la cadena completa runner→SQL sin Convex — el IO
// es fake (Map in-memory) pero el destino es la implementación real.
//
// Por qué node y no edge-runtime (el default del repo): @duckdb/node-api es un
// native addon de Node. Directiva por archivo para no afectar el resto.
//
// Cubrimos:
//  - Snapshot multi-página completo → todas las filas llegan a DuckDB.
//  - Recovery snapshot: crash antes de saveProgress no duplica filas (ON CONFLICT real).
//  - Delta insert+update+delete con DuckDB real (DELETE WHERE _id funciona).
//  - Recovery delta: crash antes de saveProgress no duplica ni pierde.
//  - Schema migration aditiva: ALTER ADD COLUMN preserva datos viejos.
//  - Self-heal: DROP TABLE → watchdogDecide detecta con tableExists real.
//  - Lote grande (500 filas) en una sola página — sin límite práctico.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDuckDestination } from "@notchat/duck-destination";
import type { Destination } from "@notchat/destination-types";
import {
  processSnapshotPage,
  type SnapshotIO,
  type SnapshotProgress,
} from "../../../packages/convex-sync-motherduck/src/snapshot/runner";
import {
  processDeltaBatch,
  type DeltaIO,
  type DeltaProgress,
} from "../../../packages/convex-sync-motherduck/src/delta/runner";
import {
  watchdogDecide,
  type WatchdogTableState,
} from "../../../packages/convex-sync-motherduck/src/watchdog/index";
import type { DeltaPage } from "../../../packages/convex-sync-motherduck/src/streaming/documentDeltas";
import type { ListSnapshotPage } from "../../../packages/convex-sync-motherduck/src/streaming/listSnapshot";

// ---------------------------------------------------------------------------
// Spec compartido
// ---------------------------------------------------------------------------

const COLUMNS = [
  { name: "_id", type: "string" as const },
  { name: "name", type: "string" as const },
  { name: "score", type: "number" as const },
];

const TABLE = { name: "items", columns: COLUMNS };

// ---------------------------------------------------------------------------
// Fakes de IO (sin Convex real)
// ---------------------------------------------------------------------------

class FakeSnapshotIO implements SnapshotIO {
  readonly progress = new Map<string, SnapshotProgress>();
  readonly done = new Map<string, number>();
  readonly warnings: string[] = [];

  async loadProgress(t: string): Promise<SnapshotProgress> {
    return this.progress.get(t) ?? { cursor: undefined, rowsApplied: 0 };
  }
  async saveProgress(t: string, p: SnapshotProgress) {
    this.progress.set(t, p);
  }
  async markSnapshotDone(t: string, ts: number) {
    this.done.set(t, ts);
  }
  logWarning(msg: string, _ctx: Record<string, unknown>) {
    this.warnings.push(msg);
  }
}

class FakeDeltaIO implements DeltaIO {
  readonly progress = new Map<string, DeltaProgress>();
  readonly warnings: string[] = [];

  async loadProgress(t: string): Promise<DeltaProgress> {
    return this.progress.get(t) ?? { cursor: "0", rowsApplied: 0 };
  }
  async saveProgress(t: string, p: DeltaProgress) {
    this.progress.set(t, p);
  }
  logWarning(msg: string, _ctx: Record<string, unknown>) {
    this.warnings.push(msg);
  }
}

// ---------------------------------------------------------------------------
// Helpers para crear fetchers fake
// ---------------------------------------------------------------------------

function makeSnapFetcher(pages: ListSnapshotPage[]) {
  const queue = [...pages];
  return async (_args: { tableName: string; cursor?: string }): Promise<ListSnapshotPage> => {
    const next = queue.shift();
    if (!next) throw new Error("snapshot fetcher: queue vacío");
    return next;
  };
}

function makeDeltaFetcher(pages: DeltaPage[]) {
  const queue = [...pages];
  return async (_args: { cursor: string }): Promise<DeltaPage> => {
    const next = queue.shift();
    if (!next) throw new Error("delta fetcher: queue vacío");
    return next;
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("pipeline integration — runner + DuckDB real (:memory:)", () => {
  let dst: Destination;

  beforeEach(async () => {
    dst = await createDuckDestination({ kind: "duckdb_local", path: ":memory:" });
  });

  afterEach(async () => {
    await dst.close();
  });

  // ── Snapshot ──────────────────────────────────────────────────────────────

  it("snapshot multi-página: todas las filas llegan a DuckDB", async () => {
    const io = new FakeSnapshotIO();

    // Página 1 de 2
    const r1 = await processSnapshotPage({
      origin: "http://x",
      deployKey: "k",
      table: TABLE,
      destination: dst,
      io,
      fetchPage: makeSnapFetcher([
        {
          values: [
            { _id: "a", _creationTime: 1, name: "A", score: 1 },
            { _id: "b", _creationTime: 2, name: "B", score: 2 },
          ],
          cursor: "c1",
          hasMore: true,
        },
      ]),
    });
    expect(r1.kind).toBe("more");
    expect(await dst.countRows("items")).toBe(2);

    // Página 2 de 2 — el io tiene cursor="c1" del paso anterior
    const r2 = await processSnapshotPage({
      origin: "http://x",
      deployKey: "k",
      table: TABLE,
      destination: dst,
      io,
      fetchPage: makeSnapFetcher([
        {
          values: [{ _id: "c", _creationTime: 3, name: "C", score: 3 }],
          cursor: "c2",
          hasMore: false,
          snapshotTs: 9999,
        },
      ]),
    });
    expect(r2.kind).toBe("done");
    expect(await dst.countRows("items")).toBe(3);
    expect(io.done.get("items")).toBe(9999);
  });

  it("recovery snapshot: crash antes de saveProgress no duplica filas", async () => {
    const io = new FakeSnapshotIO();
    const page: ListSnapshotPage = {
      values: [
        { _id: "a", _creationTime: 1, name: "A", score: 1 },
        { _id: "b", _creationTime: 2, name: "B", score: 2 },
      ],
      cursor: "c1",
      hasMore: false,
      snapshotTs: 42,
    };

    // Primer intento: tx commitea al destino (DuckDB real) pero saveProgress falla.
    const ioBoom: SnapshotIO = {
      ...io,
      loadProgress: io.loadProgress.bind(io),
      markSnapshotDone: io.markSnapshotDone.bind(io),
      saveProgress: async () => { throw new Error("simulated crash"); },
      logWarning: io.logWarning.bind(io),
    };

    await expect(
      processSnapshotPage({
        origin: "http://x",
        deployKey: "k",
        table: TABLE,
        destination: dst,
        io: ioBoom,
        fetchPage: makeSnapFetcher([page]),
      }),
    ).rejects.toThrow("simulated crash");

    // DuckDB ya tiene las filas, cursor no avanzó en Convex (io).
    expect(await dst.countRows("items")).toBe(2);
    expect(io.progress.get("items")).toBeUndefined();

    // Segunda pasada: misma página → ON CONFLICT en DuckDB real no duplica.
    const r = await processSnapshotPage({
      origin: "http://x",
      deployKey: "k",
      table: TABLE,
      destination: dst,
      io,
      fetchPage: makeSnapFetcher([page]),
    });
    expect(r.kind).toBe("done");
    expect(await dst.countRows("items")).toBe(2); // sin duplicados
    expect(io.done.get("items")).toBe(42);
  });

  it("snapshot de lote grande (500 filas) en una página — sin límite práctico", async () => {
    const io = new FakeSnapshotIO();
    const rows = Array.from({ length: 500 }, (_, i) => ({
      _id: `id-${i}`,
      _creationTime: i,
      name: `item-${i}`,
      score: i * 1.5,
    }));

    await processSnapshotPage({
      origin: "http://x",
      deployKey: "k",
      table: TABLE,
      destination: dst,
      io,
      fetchPage: makeSnapFetcher([
        { values: rows, cursor: "big", hasMore: false, snapshotTs: 1 },
      ]),
    });

    expect(await dst.countRows("items")).toBe(500);
  });

  // ── Delta ─────────────────────────────────────────────────────────────────

  it("delta insert+update+delete con DuckDB real", async () => {
    // Primero snapshot mínimo para crear la tabla.
    const snapIo = new FakeSnapshotIO();
    await processSnapshotPage({
      origin: "http://x",
      deployKey: "k",
      table: TABLE,
      destination: dst,
      io: snapIo,
      fetchPage: makeSnapFetcher([
        {
          values: [{ _id: "a", _creationTime: 1, name: "A", score: 1 }],
          cursor: "snap",
          hasMore: false,
          snapshotTs: 100,
        },
      ]),
    });
    expect(await dst.countRows("items")).toBe(1);

    const deltaIo = new FakeDeltaIO();
    deltaIo.progress.set("items", { cursor: "snap", rowsApplied: 1 });

    // insert b
    await processDeltaBatch({
      origin: "http://x",
      deployKey: "k",
      table: TABLE,
      destination: dst,
      io: deltaIo,
      fetchBatch: makeDeltaFetcher([
        {
          values: [
            { ts: 101, id: "b", action: "insert", fields: { _id: "b", _creationTime: 2, name: "B", score: 2 } },
          ],
          cursor: "d1",
          hasMore: false,
        },
      ]),
    });
    expect(await dst.countRows("items")).toBe(2);

    // update a → score cambia a 99
    await processDeltaBatch({
      origin: "http://x",
      deployKey: "k",
      table: TABLE,
      destination: dst,
      io: deltaIo,
      fetchBatch: makeDeltaFetcher([
        {
          values: [
            { ts: 102, id: "a", action: "replace", fields: { _id: "a", _creationTime: 1, name: "A", score: 99 } },
          ],
          cursor: "d2",
          hasMore: false,
        },
      ]),
    });
    expect(await dst.countRows("items")).toBe(2);

    // delete b
    await processDeltaBatch({
      origin: "http://x",
      deployKey: "k",
      table: TABLE,
      destination: dst,
      io: deltaIo,
      fetchBatch: makeDeltaFetcher([
        {
          values: [{ ts: 103, id: "b", action: "delete" }],
          cursor: "d3",
          hasMore: false,
        },
      ]),
    });
    expect(await dst.countRows("items")).toBe(1);
    expect(deltaIo.progress.get("items")!.cursor).toBe("d3");
  });

  it("recovery delta: crash antes de saveProgress no duplica filas", async () => {
    // Tabla vacía para el test.
    const io = new FakeDeltaIO();
    io.progress.set("items", { cursor: "start", rowsApplied: 0 });

    const page: DeltaPage = {
      values: [
        { ts: 1, id: "x", action: "insert", fields: { _id: "x", _creationTime: 1, name: "X", score: 10 } },
        { ts: 2, id: "y", action: "insert", fields: { _id: "y", _creationTime: 2, name: "Y", score: 20 } },
      ],
      cursor: "c1",
      hasMore: false,
    };

    // Primer intento: commit a DuckDB exitoso, saveProgress falla.
    const ioBoom: DeltaIO = {
      ...io,
      loadProgress: io.loadProgress.bind(io),
      saveProgress: async () => { throw new Error("boom"); },
      logWarning: io.logWarning.bind(io),
    };

    await expect(
      processDeltaBatch({
        origin: "http://x",
        deployKey: "k",
        table: TABLE,
        destination: dst,
        io: ioBoom,
        fetchBatch: makeDeltaFetcher([page]),
      }),
    ).rejects.toThrow("boom");

    // DuckDB tiene las filas, cursor sigue en "start".
    expect(await dst.countRows("items")).toBe(2);
    expect(io.progress.get("items")!.cursor).toBe("start");

    // Segunda pasada: misma página, ON CONFLICT no duplica.
    const r = await processDeltaBatch({
      origin: "http://x",
      deployKey: "k",
      table: TABLE,
      destination: dst,
      io,
      fetchBatch: makeDeltaFetcher([page]),
    });
    expect(r.kind).toBe("idle");
    expect(await dst.countRows("items")).toBe(2);
    expect(io.progress.get("items")!.cursor).toBe("c1");
  });

  // ── Schema migrations ─────────────────────────────────────────────────────

  it("schema migration aditiva: columna nueva → ALTER ADD COLUMN, datos viejos con NULL", async () => {
    const io = new FakeSnapshotIO();

    // Snapshot inicial con schema original.
    await processSnapshotPage({
      origin: "http://x",
      deployKey: "k",
      table: TABLE,
      destination: dst,
      io,
      fetchPage: makeSnapFetcher([
        {
          values: [{ _id: "a", _creationTime: 1, name: "A", score: 10 }],
          cursor: "c1",
          hasMore: false,
          snapshotTs: 1,
        },
      ]),
    });
    expect(await dst.countRows("items")).toBe(1);

    // Nueva columna "tags" declarada.
    const newTable = {
      name: "items",
      columns: [...COLUMNS, { name: "tags", type: "json" as const }],
    };

    // Segunda página con el schema ampliado — ensureTable hace ALTER ADD COLUMN.
    await processSnapshotPage({
      origin: "http://x",
      deployKey: "k",
      table: newTable,
      destination: dst,
      io,
      fetchPage: makeSnapFetcher([
        {
          values: [{ _id: "b", _creationTime: 2, name: "B", score: 20, tags: ["vip"] }],
          cursor: "c2",
          hasMore: false,
          snapshotTs: 2,
        },
      ]),
    });

    // Ambas filas presentes; "a" sigue siendo 1 fila.
    expect(await dst.countRows("items")).toBe(2);

    // La columna "tags" existe — verifica que la tabla tenga la columna.
    const colTypes = await dst.columnTypes("items");
    expect(colTypes.has("tags")).toBe(true);
  });

  // ── Self-heal ─────────────────────────────────────────────────────────────

  it("self-heal: DROP TABLE → watchdogDecide detecta reset_and_snapshot con tableExists real", async () => {
    // Crear y luego borrar la tabla en DuckDB real.
    await dst.ensureTable("items", COLUMNS);
    expect(await dst.tableExists("items")).toBe(true);
    await dst.dropTable("items");
    expect(await dst.tableExists("items")).toBe(false);

    const NOW = Date.now();
    const tables: WatchdogTableState[] = [
      {
        name: "items",
        status: "running_delta",
        snapshotTs: 42,
        lastAppliedAtMs: NOW - 5_000, // job reciente (no está trabado)
        lastError: undefined,
      },
    ];

    // watchdogDecide llama a dst.tableExists("items") — DuckDB real dice false.
    const actions = await watchdogDecide(tables, dst, NOW);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe("reset_and_snapshot");
    expect(actions[0]!.tableName).toBe("items");
  });
});
