import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";

// Volúmenes mínimos exigidos por la prueba.
const SEED_CONFIG = {
  tenants: 3,
  contactsPerTenant: 200, // 3 * 200 = 600 ≥ 500
  conversationsPerContact: 1,
  messagesPerConversation: 4, // 600 * 4 = 2400 ≥ 2000
  attributesPerTenant: 5,
  attributeFillRatio: 0.6, // ~0.6 * 600 * 5 ≈ 1800 ≥ 1000
  baseSeed: 0xC0FFEE,
} as const;

// Convex limita ~8192 writes por transacción. Trabajo de a chunks
// holgados para no acercarme al techo.
const WIPE_CHUNK = 1024;
const TENANT_CHUNK_SIZE = 1; // un tenant por mutation: ~2000 writes c/u

// PRNG determinístico (mulberry32). Mismo seed → mismos datos →
// los tests pueden hacer asserts exactos.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TABLES = [
  "contactAttributes",
  "messages",
  "conversations",
  "attributes",
  "contacts",
  "tenants",
] as const;
type TableName = (typeof TABLES)[number];

const TENANT_NAMES = ["Acme Coffee", "Luna Salon", "Pampa Books"];
const FIRST_NAMES = [
  "Sofía", "Mateo", "Valentina", "Lucas", "Camila", "Bruno",
  "Martina", "Joaquín", "Catalina", "Tomás",
];
const LAST_NAMES = [
  "Pérez", "González", "Fernández", "Rodríguez", "López",
  "Martínez", "Sosa", "Romero", "Álvarez", "Torres",
];
const ATTRIBUTE_DEFS: Array<{
  key: string;
  label: string;
  type: Doc<"attributes">["type"];
  values: ReadonlyArray<string>;
}> = [
  { key: "city", label: "Ciudad", type: "string", values: ["BA", "Córdoba", "Rosario"] },
  { key: "vip", label: "VIP", type: "boolean", values: ["true", "false"] },
  { key: "ltv", label: "Lifetime value", type: "number", values: ["100", "500", "1200", "3400"] },
  { key: "joined_at", label: "Alta", type: "date", values: ["2024-01-01", "2025-06-15"] },
  { key: "tier", label: "Tier", type: "enum", values: ["bronze", "silver", "gold"] },
];

const MESSAGE_TEMPLATES_INBOUND = [
  "Hola, tienen turno hoy?",
  "Gracias por el envío!",
  "Quiero cancelar mi pedido",
  "Cuánto sale el plan anual?",
];
const MESSAGE_TEMPLATES_OUTBOUND = [
  "Hola! Sí, te confirmo en un minuto.",
  "Genial, gracias a vos!",
  "Te ayudo, pasame el número de orden.",
  "Te paso el link con los precios.",
];

const STATUSES = ["open", "pending", "closed"] as const;

function pick<T>(rng: () => number, arr: ReadonlyArray<T>): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

// ─── Mutations atómicas (chunks) ──────────────────────────────────────

export const wipeChunk = internalMutation({
  args: { table: v.string() },
  handler: async (ctx, { table }) => {
    const t = table as TableName;
    const docs = await ctx.db.query(t).take(WIPE_CHUNK);
    for (const doc of docs) await ctx.db.delete(doc._id);
    return { deleted: docs.length, hasMore: docs.length === WIPE_CHUNK };
  },
});

export const seedTenant = internalMutation({
  args: { tenantIndex: v.number() },
  handler: async (ctx, { tenantIndex: t }) => {
    // Cada tenant usa su propio sub-stream del PRNG para que el resultado
    // sea independiente del orden de ejecución de los chunks.
    const rng = mulberry32(SEED_CONFIG.baseSeed + t * 0x9E3779B1);
    const baseTime = Date.UTC(2025, 0, 1);

    const tenantName = TENANT_NAMES[t % TENANT_NAMES.length]!;
    const slug = tenantName.toLowerCase().replace(/\s+/g, "-");
    const tenantId: Id<"tenants"> = await ctx.db.insert("tenants", {
      name: tenantName,
      slug,
    });

    const attributeIds: Array<Id<"attributes">> = [];
    for (const def of ATTRIBUTE_DEFS.slice(0, SEED_CONFIG.attributesPerTenant)) {
      const id = await ctx.db.insert("attributes", {
        tenantId,
        key: def.key,
        label: def.label,
        type: def.type,
      });
      attributeIds.push(id);
    }

    await populateTenant(ctx, rng, baseTime, tenantId, attributeIds);
  },
});

async function populateTenant(
  ctx: MutationCtx,
  rng: () => number,
  baseTime: number,
  tenantId: Id<"tenants">,
  attributeIds: ReadonlyArray<Id<"attributes">>,
) {
  for (let c = 0; c < SEED_CONFIG.contactsPerTenant; c++) {
    const first = pick(rng, FIRST_NAMES);
    const last = pick(rng, LAST_NAMES);
    const externalId = `${tenantId}-c${c}`;
    const contactId = await ctx.db.insert("contacts", {
      tenantId,
      externalId,
      name: `${first} ${last}`,
      phone: `+549${String(Math.floor(rng() * 1e10)).padStart(10, "0")}`,
      createdAtMs: baseTime + Math.floor(rng() * 30 * 24 * 3600 * 1000),
      ...(rng() < 0.7
        ? { email: `${first}.${last}.${c}@example.com`.toLowerCase() }
        : {}),
    });

    for (let cv = 0; cv < SEED_CONFIG.conversationsPerContact; cv++) {
      const conversationStart = baseTime + Math.floor(rng() * 90 * 24 * 3600 * 1000);
      const conversationId = await ctx.db.insert("conversations", {
        tenantId,
        contactId,
        status: pick(rng, STATUSES),
        openedAtMs: conversationStart,
        lastMessageAtMs: conversationStart,
      });

      let cursor = conversationStart;
      for (let m = 0; m < SEED_CONFIG.messagesPerConversation; m++) {
        const inbound = rng() < 0.5;
        cursor += Math.floor(rng() * 3600 * 1000);
        await ctx.db.insert("messages", {
          tenantId,
          conversationId,
          direction: inbound ? "inbound" : "outbound",
          body: pick(
            rng,
            inbound ? MESSAGE_TEMPLATES_INBOUND : MESSAGE_TEMPLATES_OUTBOUND,
          ),
          sentAtMs: cursor,
        });
      }
      await ctx.db.patch(conversationId, { lastMessageAtMs: cursor });
    }

    for (let a = 0; a < attributeIds.length; a++) {
      if (rng() > SEED_CONFIG.attributeFillRatio) continue;
      const attrId = attributeIds[a]!;
      const def = ATTRIBUTE_DEFS[a]!;
      await ctx.db.insert("contactAttributes", {
        tenantId,
        contactId,
        attributeId: attrId,
        value: pick(rng, def.values),
      });
    }
  }
}

export const counts = internalMutation({
  args: {},
  handler: async (ctx) => ({
    tenants: (await ctx.db.query("tenants").collect()).length,
    contacts: (await ctx.db.query("contacts").collect()).length,
    conversations: (await ctx.db.query("conversations").collect()).length,
    messages: (await ctx.db.query("messages").collect()).length,
    attributes: (await ctx.db.query("attributes").collect()).length,
    contactAttributes: (await ctx.db.query("contactAttributes").collect()).length,
  }),
});

// ─── Orquestador ──────────────────────────────────────────────────────

export const run = internalAction({
  args: {},
  handler: async (ctx): Promise<Record<TableName, number>> => {
    // Wipe respetando dependencias (children antes que parents).
    for (const table of TABLES) {
      let hasMore = true;
      while (hasMore) {
        const res = await ctx.runMutation(internal.seed.wipeChunk, { table });
        hasMore = res.hasMore;
      }
    }
    for (let t = 0; t < SEED_CONFIG.tenants; t += TENANT_CHUNK_SIZE) {
      await ctx.runMutation(internal.seed.seedTenant, { tenantIndex: t });
    }
    return (await ctx.runMutation(internal.seed.counts, {})) as Record<TableName, number>;
  },
});
