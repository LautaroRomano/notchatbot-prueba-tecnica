// @vitest-environment node
//
// Por qué `node` y no `edge-runtime` (default del repo): `@duckdb/node-api`
// es un native addon de Node, no corre en edge-runtime. La directiva de
// arriba override-ea el environment global SÓLO para este archivo —
// el resto de los tests (convex-test) sigue en edge-runtime.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDuckDestination } from "./duck";
import type { Destination, Row } from "./types";

const SPEC = [
  { name: "_id", type: "string" as const },
  { name: "name", type: "string" as const },
  { name: "age", type: "number" as const },
  { name: "active", type: "boolean" as const },
  { name: "meta", type: "json" as const },
];

describe("DuckDestination (in-memory)", () => {
  let dst: Destination;

  beforeEach(async () => {
    // `:memory:` da una DB efímera por test — aislamiento total, no necesita
    // limpieza de tmp files y es lo bastante rápido para no preocuparse.
    dst = await createDuckDestination({
      kind: "duckdb_local",
      path: ":memory:",
    });
  });

  afterEach(async () => {
    await dst.close();
  });

  it("ensureTable crea la tabla con _id PRIMARY KEY", async () => {
    await dst.ensureTable("contacts", SPEC);
    expect(await dst.tableExists("contacts")).toBe(true);
    expect(await dst.countRows("contacts")).toBe(0);
  });

  it("ensureTable es idempotente", async () => {
    await dst.ensureTable("contacts", SPEC);
    await dst.ensureTable("contacts", SPEC);
    expect(await dst.tableExists("contacts")).toBe(true);
  });

  it("applyBatch upsertea filas y countRows refleja el total", async () => {
    await dst.ensureTable("contacts", SPEC);
    const rows: Row[] = [
      { _id: "a", name: "Alice", age: 30, active: true, meta: { tag: "vip" } },
      { _id: "b", name: "Bob", age: 25, active: false, meta: null },
    ];
    await dst.withTransaction(() => dst.applyBatch("contacts", rows));
    expect(await dst.countRows("contacts")).toBe(2);
  });

  it("applyBatch es idempotente (re-aplicar deja el mismo estado)", async () => {
    await dst.ensureTable("contacts", SPEC);
    const rows: Row[] = [
      { _id: "a", name: "Alice", age: 30, active: true, meta: null },
      { _id: "b", name: "Bob", age: 25, active: false, meta: null },
    ];
    await dst.withTransaction(() => dst.applyBatch("contacts", rows));
    await dst.withTransaction(() => dst.applyBatch("contacts", rows));
    await dst.withTransaction(() => dst.applyBatch("contacts", rows));
    expect(await dst.countRows("contacts")).toBe(2);
  });

  it("applyBatch actualiza (no duplica) cuando _id ya existe", async () => {
    await dst.ensureTable("contacts", SPEC);
    await dst.withTransaction(() =>
      dst.applyBatch("contacts", [
        { _id: "a", name: "Alice", age: 30, active: true, meta: null },
      ]),
    );
    await dst.withTransaction(() =>
      dst.applyBatch("contacts", [
        { _id: "a", name: "Alice updated", age: 31, active: false, meta: null },
      ]),
    );
    expect(await dst.countRows("contacts")).toBe(1);
    // Validamos la actualización con una consulta directa al motor.
    const dstAny = dst as unknown as { conn: { runAndReadAll: any } };
    const reader = await dstAny.conn.runAndReadAll(
      "SELECT name, age, active FROM contacts WHERE _id = 'a'",
    );
    const [row] = reader.getRowObjectsJS();
    expect(row).toEqual({ name: "Alice updated", age: 31, active: false });
  });

  it("applyDeletes borra por _id", async () => {
    await dst.ensureTable("contacts", SPEC);
    await dst.withTransaction(() =>
      dst.applyBatch("contacts", [
        { _id: "a", name: "Alice", age: 30, active: true, meta: null },
        { _id: "b", name: "Bob", age: 25, active: false, meta: null },
      ]),
    );
    await dst.withTransaction(() => dst.applyDeletes("contacts", ["a"]));
    expect(await dst.countRows("contacts")).toBe(1);
  });

  it("withTransaction rollback ante error preserva el estado", async () => {
    await dst.ensureTable("contacts", SPEC);
    await dst.withTransaction(() =>
      dst.applyBatch("contacts", [
        { _id: "a", name: "Alice", age: 30, active: true, meta: null },
      ]),
    );
    await expect(
      dst.withTransaction(async () => {
        await dst.applyBatch("contacts", [
          { _id: "b", name: "Bob", age: 25, active: false, meta: null },
        ]);
        throw new Error("simulated failure mid-batch");
      }),
    ).rejects.toThrow("simulated failure");
    // La fila `b` NO debe estar — rollback la tiró.
    expect(await dst.countRows("contacts")).toBe(1);
  });

  it("ensureTable hace ALTER ADD COLUMN aditivo", async () => {
    await dst.ensureTable("contacts", SPEC);
    await dst.withTransaction(() =>
      dst.applyBatch("contacts", [
        { _id: "a", name: "Alice", age: 30, active: true, meta: null },
      ]),
    );
    // Re-llamamos con una columna nueva.
    await dst.ensureTable("contacts", [
      ...SPEC,
      { name: "nickname", type: "string" },
    ]);
    // La fila vieja sigue ahí, con `nickname` en NULL.
    expect(await dst.countRows("contacts")).toBe(1);
    const dstAny = dst as unknown as { conn: { runAndReadAll: any } };
    const reader = await dstAny.conn.runAndReadAll(
      "SELECT nickname FROM contacts WHERE _id = 'a'",
    );
    const [row] = reader.getRowObjectsJS();
    expect(row).toEqual({ nickname: null });
  });

  it("dropTable saca la tabla y tableExists vuelve a false", async () => {
    await dst.ensureTable("contacts", SPEC);
    expect(await dst.tableExists("contacts")).toBe(true);
    await dst.dropTable("contacts");
    expect(await dst.tableExists("contacts")).toBe(false);
  });

  it("applyBatch fuera de tx falla con mensaje claro", async () => {
    await dst.ensureTable("contacts", SPEC);
    await expect(
      dst.applyBatch("contacts", [
        { _id: "a", name: "Alice", age: 30, active: true, meta: null },
      ]),
    ).rejects.toThrow(/must run inside withTransaction/);
  });

  it("rechaza identificadores inseguros", async () => {
    await expect(
      dst.ensureTable("contacts; DROP TABLE foo", SPEC),
    ).rejects.toThrow(/Unsafe identifier/);
  });

  it("serializa JSON cuando la columna es de tipo json", async () => {
    await dst.ensureTable("contacts", SPEC);
    await dst.withTransaction(() =>
      dst.applyBatch("contacts", [
        {
          _id: "a",
          name: "Alice",
          age: 30,
          active: true,
          meta: { tags: ["vip", "early"], score: 7 },
        },
      ]),
    );
    const dstAny = dst as unknown as { conn: { runAndReadAll: any } };
    const reader = await dstAny.conn.runAndReadAll(
      "SELECT meta->>'$.score' AS score FROM contacts WHERE _id = 'a'",
    );
    const [row] = reader.getRowObjectsJS();
    // DuckDB devuelve el campo extraído como string.
    expect(String(row?.score)).toBe("7");
  });
});
