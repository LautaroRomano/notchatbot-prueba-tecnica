import { describe, it, expect } from "vitest";
import { VERSION } from "./index";

describe("scaffold smoke", () => {
  it("exposes a version string", () => {
    expect(VERSION).toBe("0.0.1");
  });
});
