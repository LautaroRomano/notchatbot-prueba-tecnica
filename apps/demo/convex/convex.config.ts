import { defineApp } from "convex/server";
import motherduckSync from "convex-sync-motherduck/convex.config";

const app = defineApp();
app.use(motherduckSync);

export default app;
