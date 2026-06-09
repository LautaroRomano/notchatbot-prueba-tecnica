import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Schema completo del CRM se define en Fase 1. Por ahora un placeholder
// mínimo para que `convex dev` valide la estructura del deployment.
export default defineSchema({
  _meta: defineTable({
    key: v.string(),
    value: v.string(),
  }).index("by_key", ["key"]),
});
