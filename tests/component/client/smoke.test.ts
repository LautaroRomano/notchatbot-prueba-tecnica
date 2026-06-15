import { describe, it, expect } from "vitest";
import { MotherduckSync, VERSION } from "../../../packages/convex-sync-motherduck/src/client/index";

describe("client API", () => {
  it("exposes a version string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("MotherduckSync se instancia con un component ref", () => {
    const fakeRef = {
      config: { set: "ref:config.set", get: "ref:config.get" },
      tables: {
        register: "ref:tables.register",
        status: "ref:tables.status",
        _listSyncTargets: "ref:_listSyncTargets",
        _listPendingNames: "ref:_listPendingNames",
        _loadSnapshotProgress: "ref:_loadSnapshotProgress",
        _saveSnapshotProgress: "ref:_saveSnapshotProgress",
        _markSnapshotDone: "ref:_markSnapshotDone",
        _markError: "ref:_markError",
      },
    };
    const sync = new MotherduckSync(fakeRef);
    expect(typeof sync.setConfig).toBe("function");
    expect(typeof sync.registerSyncedTables).toBe("function");
    expect(typeof sync.status).toBe("function");
    expect(typeof sync.processOneSnapshotPage).toBe("function");
    expect(typeof sync.listPendingTables).toBe("function");
    expect(typeof sync.markError).toBe("function");
  });
});
