import { describe, expect, it } from "vitest";

import { RuntimeIRV3Schema, ScenarioPackageV1Schema, personalFlowContractVersion } from "./index";

describe("contracts package baseline", () => {
  it("exports the PersonalFlow contract version", () => {
    expect(personalFlowContractVersion).toBe("0.1.0");
  });

  it("exports RuntimeIR v3 contract schemas", () => {
    expect(RuntimeIRV3Schema).toBeDefined();
    expect(ScenarioPackageV1Schema).toBeDefined();
  });
});
