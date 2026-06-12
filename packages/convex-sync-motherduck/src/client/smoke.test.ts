import { describe, it, expect } from "vitest";
import { MotherduckSync, VERSION } from "./index";

describe("client API", () => {
  it("exposes a version string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("MotherduckSync se instancia con un component ref", () => {
    const fakeRef = {
      config: { set: "ref:config.set", get: "ref:config.get" },
      tables: { register: "ref:tables.register", status: "ref:tables.status" },
    };
    const sync = new MotherduckSync(fakeRef);
    expect(typeof sync.setConfig).toBe("function");
    expect(typeof sync.registerSyncedTables).toBe("function");
    expect(typeof sync.status).toBe("function");
  });
});
