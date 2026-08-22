import { describe, expect, it } from "vitest";
import { ReconcilerResultSchema, RoleSchema } from "../../../src/domain/contracts.js";

describe("RoleSchema", () => {
  it("accepts reconciler as a valid role", () => {
    expect(RoleSchema.safeParse("reconciler").success).toBe(true);
  });
});

describe("ReconcilerResultSchema", () => {
  it("accepts an empty coverage/patches result", () => {
    const result = ReconcilerResultSchema.safeParse({ coverage: [], patches: [] });
    expect(result.success).toBe(true);
  });

  it("accepts a populated result", () => {
    const result = ReconcilerResultSchema.safeParse({
      coverage: [
        {
          requirementId: "REQ-AUTH-001",
          description: "Users can log in via GitHub",
          epic: 12,
          issues: [15],
          status: "covered",
          evidence: "issue #15",
        },
      ],
      patches: [{ type: "KEEP", issue: 15, reason: "correct as-is" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a result missing the patches field", () => {
    const result = ReconcilerResultSchema.safeParse({ coverage: [] });
    expect(result.success).toBe(false);
  });
});
