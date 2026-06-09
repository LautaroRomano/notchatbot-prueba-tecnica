/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";

// convex-test descubre los módulos vía glob de Vite. La extensión .*s
// cubre .js, .ts, .jsx, .tsx según docs.
const modules = import.meta.glob("./**/*.*s");

describe("seed", () => {
  test("primer run produce los volúmenes esperados", async () => {
    const t = convexTest(schema, modules);
    const counts = await t.action(internal.seed.run, {});

    expect(counts.tenants).toBe(3);
    expect(counts.contacts).toBe(600);
    expect(counts.conversations).toBe(600);
    expect(counts.messages).toBe(2400);
    expect(counts.attributes).toBe(15);
    expect(counts.contactAttributes).toBeGreaterThanOrEqual(1000);
  });

  test("correr dos veces deja el mismo estado (idempotente)", async () => {
    const t = convexTest(schema, modules);
    const first = await t.action(internal.seed.run, {});
    const second = await t.action(internal.seed.run, {});

    expect(second).toEqual(first);
  });
});
