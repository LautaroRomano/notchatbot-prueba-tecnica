import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// NotChat CRM — modelo B2C: un negocio (tenant) gestiona conversaciones
// con sus consumidores finales (contacts). Los messages cuelgan de
// conversations. Los attributes son definiciones de campos custom por
// tenant; contactAttributes los valoriza por contacto.
//
// Invariantes de negocio (Convex no tiene UNIQUE declarativo — se
// enforcean en las mutations de aplicación, Fase 2+):
//   - attributes:         (tenantId, key)             es único.
//   - contactAttributes:  (contactId, attributeId)    es único.
//   - contacts:           (tenantId, externalId)      es único.

export default defineSchema({
  tenants: defineTable({
    name: v.string(),
    slug: v.string(),
  }).index("by_slug", ["slug"]),

  contacts: defineTable({
    tenantId: v.id("tenants"),
    externalId: v.string(),
    name: v.string(),
    phone: v.string(),
    email: v.optional(v.string()),
    createdAtMs: v.number(),
  })
    .index("by_tenant", ["tenantId"])
    .index("by_tenant_external", ["tenantId", "externalId"]),

  conversations: defineTable({
    tenantId: v.id("tenants"),
    contactId: v.id("contacts"),
    status: v.union(
      v.literal("open"),
      v.literal("pending"),
      v.literal("closed"),
    ),
    openedAtMs: v.number(),
    lastMessageAtMs: v.number(),
  })
    .index("by_tenant", ["tenantId"])
    .index("by_contact", ["contactId"])
    .index("by_tenant_recent", ["tenantId", "lastMessageAtMs"]),

  messages: defineTable({
    tenantId: v.id("tenants"),
    conversationId: v.id("conversations"),
    direction: v.union(v.literal("inbound"), v.literal("outbound")),
    body: v.string(),
    sentAtMs: v.number(),
  })
    .index("by_conversation", ["conversationId", "sentAtMs"])
    .index("by_tenant", ["tenantId"]),

  attributes: defineTable({
    tenantId: v.id("tenants"),
    key: v.string(),
    label: v.string(),
    type: v.union(
      v.literal("string"),
      v.literal("number"),
      v.literal("boolean"),
      v.literal("date"),
      v.literal("enum"),
    ),
  })
    .index("by_tenant", ["tenantId"])
    .index("by_tenant_key", ["tenantId", "key"]),

  contactAttributes: defineTable({
    tenantId: v.id("tenants"),
    contactId: v.id("contacts"),
    attributeId: v.id("attributes"),
    value: v.string(),
  })
    .index("by_contact", ["contactId"])
    .index("by_attribute", ["attributeId"])
    .index("by_contact_attribute", ["contactId", "attributeId"]),
});
