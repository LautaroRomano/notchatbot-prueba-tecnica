declare const _default: import("convex/server").SchemaDefinition<{
    _meta: import("convex/server").TableDefinition<import("convex/values").VObject<{
        key: string;
        value: string;
    }, {
        key: import("convex/values").VString<string, "required">;
        value: import("convex/values").VString<string, "required">;
    }, "required", "key" | "value">, {
        by_key: ["key", "_creationTime"];
    }, {}, {}>;
}, true>;
export default _default;
