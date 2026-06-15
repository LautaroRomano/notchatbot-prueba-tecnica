/**
 * Tests del runner de deltas. NO usan DuckDB ni Convex reales — usan el mismo
 * `FakeDestination` in-memory que el runner de snapshot y un `fakeFetcher` de
 * páginas de deltas predefinidas.
 *
 * Cubrimos:
 *  - Secuencia insert → update → delete se aplica en orden.
 *  - Idempotencia: re-aplicar el mismo batch deja el destino en el mismo estado.
 *  - Deletes: borrar en Convex elimina la fila en el destino.
 *  - Recovery: si saveProgress falla tras el commit, la próxima iteración
 *    re-aplica el mismo batch idempotentemente sin duplicar ni perder nada.
 *  - hasMore=true self-schedula (resultado "more"); hasMore=false → "idle".
 *  - Batch vacío avanza el cursor sin escribir nada.
 */

import { describe, expect, it } from "vitest";
import type { ColumnDef, Destination, Row } from "@notchat/destination-types";
import type { DeltaPage } from "../../../packages/convex-sync-motherduck/src/streaming/documentDeltas";
import {
  processDeltaBatch,
  type DeltaIO,
  type DeltaProgress,
} from "../../../packages/convex-sync-motherduck/src/delta/runner";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const COLUMNS: ReadonlyArray<ColumnDef> = [
  { name: "_id", type: "string" },
  { name: "name", type: "string" },
  { name: "age", type: "number" },
];
const SPEC = { name: "contacts", columns: COLUMNS };

class FakeDestination implements Destination {
  readonly tables = new Map<string, Map<string, Row>>();
  readonly schemas = new Map<string, ReadonlyArray<ColumnDef>>();
  private inTx = false;

  async ensureTable(name: string, columns: ReadonlyArray<ColumnDef>) {
    if (!this.tables.has(name)) this.tables.set(name, new Map());
    this.schemas.set(name, columns);
  }
  async applyBatch(name: string, rows: ReadonlyArray<Row>) {
    if (!this.inTx) throw new Error("not in tx");
    const t = this.tables.get(name)!;
    for (const r of rows) t.set(r._id as string, { ...r });
  }
  async applyDeletes(name: string, ids: ReadonlyArray<string>) {
    if (!this.inTx) throw new Error("not in tx");
    const t = this.tables.get(name)!;
    for (const id of ids) t.delete(id);
  }
  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    this.inTx = true;
    try {
      return await fn();
    } finally {
      this.inTx = false;
    }
  }
  async tableExists(name: string) {
    return this.tables.has(name);
  }
  async countRows(name: string) {
    return this.tables.get(name)?.size ?? 0;
  }
  async dropTable(name: string) {
    this.tables.delete(name);
  }
  async close() {}
}

class FakeIO implements DeltaIO {
  readonly progress = new Map<string, DeltaProgress>();
  readonly warnings: Array<{ message: string; ctx: Record<string, unknown> }> = [];

  async loadProgress(t: string): Promise<DeltaProgress> {
    return this.progress.get(t) ?? { cursor: "0", rowsApplied: 0 };
  }
  async saveProgress(t: string, p: DeltaProgress) {
    this.progress.set(t, p);
  }
  logWarning(message: string, ctx: Record<string, unknown>) {
    this.warnings.push({ message, ctx });
  }
}

function fakeFetcher(pages: DeltaPage[]) {
  const queue = [...pages];
  const calls: Array<{ cursor: string }> = [];
  const fn = async (args: { cursor: string }): Promise<DeltaPage> => {
    calls.push({ cursor: args.cursor });
    const next = queue.shift();
    if (!next) throw new Error("fakeFetcher: queue empty");
    return next;
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processDeltaBatch", () => {
  it("insert → update → delete se aplican en orden", async () => {
    const dst = new FakeDestination();
    const io = new FakeIO();
    // Página 1: insert a + b
    const { fn: fetch1 } = fakeFetcher([
      {
        values: [
          { ts: 1, id: "a", action: "insert", fields: { _id: "a", _creationTime: 1, name: "A", age: 1 } },
          { ts: 2, id: "b", action: "insert", fields: { _id: "b", _creationTime: 2, name: "B", age: 2 } },
        ],
        cursor: "c1",
        hasMore: false,
      },
    ]);
    const r1 = await processDeltaBatch({
      origin: "http://x",
      deployKey: "k",
      table: SPEC,
      destination: dst,
      io,
      fetchBatch: fetch1,
    });
    expect(r1.kind).toBe("idle");
    expect(await dst.countRows("contacts")).toBe(2);

    // Página 2: update a, delete b
    const { fn: fetch2 } = fakeFetcher([
      {
        values: [
          { ts: 3, id: "a", action: "replace", fields: { _id: "a", _creationTime: 1, name: "A-updated", age: 10 } },
          { ts: 4, id: "b", action: "delete" },
        ],
        cursor: "c2",
        hasMore: false,
      },
    ]);
    io.progress.set("contacts", { cursor: "c1", rowsApplied: 2 });
    const r2 = await processDeltaBatch({
      origin: "http://x",
      deployKey: "k",
      table: SPEC,
      destination: dst,
      io,
      fetchBatch: fetch2,
    });
    expect(r2.kind).toBe("idle");
    expect(await dst.countRows("contacts")).toBe(1);
    const row = dst.tables.get("contacts")!.get("a")!;
    expect(row["name"]).toBe("A-updated");
    expect(row["age"]).toBe(10);
    expect(dst.tables.get("contacts")!.has("b")).toBe(false);
  });

  it("idempotencia: re-aplicar el mismo batch deja el destino igual", async () => {
    const dst = new FakeDestination();
    const io = new FakeIO();
    const page: DeltaPage = {
      values: [
        { ts: 1, id: "a", action: "insert", fields: { _id: "a", _creationTime: 1, name: "A", age: 1 } },
        { ts: 2, id: "b", action: "insert", fields: { _id: "b", _creationTime: 2, name: "B", age: 2 } },
      ],
      cursor: "c1",
      hasMore: false,
    };

    // Primera aplicación.
    const { fn: f1 } = fakeFetcher([page]);
    await processDeltaBatch({ origin: "http://x", deployKey: "k", table: SPEC, destination: dst, io, fetchBatch: f1 });
    expect(await dst.countRows("contacts")).toBe(2);

    // Cursor reset a "0" (simulamos que saveProgress falló).
    io.progress.delete("contacts");

    // Segunda aplicación del mismo batch.
    const { fn: f2 } = fakeFetcher([page]);
    await processDeltaBatch({ origin: "http://x", deployKey: "k", table: SPEC, destination: dst, io, fetchBatch: f2 });
    // No duplicó nada.
    expect(await dst.countRows("contacts")).toBe(2);
  });

  it("deletes: borrar en Convex elimina la fila en el destino", async () => {
    const dst = new FakeDestination();
    const io = new FakeIO();

    // Primero insertar una fila.
    const { fn: fInsert } = fakeFetcher([
      {
        values: [
          { ts: 1, id: "x", action: "insert", fields: { _id: "x", _creationTime: 1, name: "X", age: 5 } },
        ],
        cursor: "c1",
        hasMore: false,
      },
    ]);
    await processDeltaBatch({ origin: "http://x", deployKey: "k", table: SPEC, destination: dst, io, fetchBatch: fInsert });
    expect(await dst.countRows("contacts")).toBe(1);

    // Ahora delete.
    io.progress.set("contacts", { cursor: "c1", rowsApplied: 1 });
    const { fn: fDelete } = fakeFetcher([
      {
        values: [{ ts: 2, id: "x", action: "delete" }],
        cursor: "c2",
        hasMore: false,
      },
    ]);
    await processDeltaBatch({ origin: "http://x", deployKey: "k", table: SPEC, destination: dst, io, fetchBatch: fDelete });
    expect(await dst.countRows("contacts")).toBe(0);
    expect(io.progress.get("contacts")!.cursor).toBe("c2");
  });

  it("recovery: si saveProgress falla tras commit, repetir batch no duplica filas", async () => {
    const dst = new FakeDestination();
    const io = new FakeIO();
    const page: DeltaPage = {
      values: [
        { ts: 1, id: "a", action: "insert", fields: { _id: "a", _creationTime: 1, name: "A", age: 1 } },
        { ts: 2, id: "b", action: "insert", fields: { _id: "b", _creationTime: 2, name: "B", age: 2 } },
      ],
      cursor: "c1",
      hasMore: false,
    };

    // Primer intento: commit al destino exitoso pero saveProgress lanza.
    const ioBoom: DeltaIO = {
      ...io,
      loadProgress: io.loadProgress.bind(io),
      saveProgress: async () => {
        throw new Error("simulated crash before cursor commit");
      },
      logWarning: io.logWarning.bind(io),
    };
    const { fn: f1 } = fakeFetcher([page]);
    await expect(
      processDeltaBatch({ origin: "http://x", deployKey: "k", table: SPEC, destination: dst, io: ioBoom, fetchBatch: f1 }),
    ).rejects.toThrow("simulated crash");

    // Destino tiene las filas pero cursor no avanzó.
    expect(await dst.countRows("contacts")).toBe(2);
    expect(io.progress.get("contacts")).toBeUndefined();

    // Segundo intento con IO funcional — re-aplica el mismo batch, sin duplicar.
    const { fn: f2 } = fakeFetcher([page]);
    const r = await processDeltaBatch({ origin: "http://x", deployKey: "k", table: SPEC, destination: dst, io, fetchBatch: f2 });
    expect(r.kind).toBe("idle");
    expect(await dst.countRows("contacts")).toBe(2); // no se duplicó
    expect(io.progress.get("contacts")!.cursor).toBe("c1");
  });

  it("hasMore=true devuelve 'more' con el cursor actualizado", async () => {
    const dst = new FakeDestination();
    const io = new FakeIO();
    const { fn } = fakeFetcher([
      {
        values: [
          { ts: 1, id: "a", action: "insert", fields: { _id: "a", _creationTime: 1, name: "A", age: 1 } },
        ],
        cursor: "c1",
        hasMore: true,
      },
    ]);
    const r = await processDeltaBatch({ origin: "http://x", deployKey: "k", table: SPEC, destination: dst, io, fetchBatch: fn });
    expect(r.kind).toBe("more");
    if (r.kind === "more") {
      expect(r.cursor).toBe("c1");
      expect(r.changesThisBatch).toBe(1);
    }
  });

  it("batch vacío avanza el cursor sin escribir nada", async () => {
    const dst = new FakeDestination();
    const io = new FakeIO();
    io.progress.set("contacts", { cursor: "c0", rowsApplied: 5 });
    const { fn } = fakeFetcher([
      { values: [], cursor: "c1", hasMore: false },
    ]);
    const r = await processDeltaBatch({ origin: "http://x", deployKey: "k", table: SPEC, destination: dst, io, fetchBatch: fn });
    expect(r.kind).toBe("idle");
    expect(io.progress.get("contacts")!.cursor).toBe("c1");
    // rowsApplied no cambió (sin inserts ni deletes).
    expect(io.progress.get("contacts")!.rowsApplied).toBe(5);
  });

  it("descarta campos no declarados con warning", async () => {
    const dst = new FakeDestination();
    const io = new FakeIO();
    const { fn } = fakeFetcher([
      {
        values: [
          {
            ts: 1,
            id: "a",
            action: "insert",
            fields: {
              _id: "a",
              _creationTime: 1,
              name: "A",
              age: 1,
              secret: "drop-me", // no declarado
            },
          },
        ],
        cursor: "c1",
        hasMore: false,
      },
    ]);
    await processDeltaBatch({ origin: "http://x", deployKey: "k", table: SPEC, destination: dst, io, fetchBatch: fn });
    const stored = dst.tables.get("contacts")!.get("a")!;
    expect(Object.keys(stored).sort()).toEqual(["_id", "age", "name"]);
    expect(io.warnings).toHaveLength(1);
    expect(io.warnings[0]!.ctx).toMatchObject({ extras: ["secret"] });
  });
});
