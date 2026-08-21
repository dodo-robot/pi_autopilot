import { describe, expect, it } from "vitest";
import { BrainstormerResultSchema, RoleSchema } from "../../../src/domain/contracts.js";

describe("BrainstormerResultSchema", () => {
  it("accepts a valid result with one question", () => {
    const result = BrainstormerResultSchema.safeParse({
      questions: [{ id: "q1", text: "What is the real goal?" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid result with three questions", () => {
    const result = BrainstormerResultSchema.safeParse({
      questions: [
        { id: "q1", text: "What is the real goal?" },
        { id: "q2", text: "What does done look like?" },
        { id: "q3", text: "Any constraints I should know?" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects zero questions", () => {
    const result = BrainstormerResultSchema.safeParse({ questions: [] });
    expect(result.success).toBe(false);
  });

  it("rejects more than three questions", () => {
    const result = BrainstormerResultSchema.safeParse({
      questions: [
        { id: "q1", text: "A" },
        { id: "q2", text: "B" },
        { id: "q3", text: "C" },
        { id: "q4", text: "D" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a question with an empty id", () => {
    const result = BrainstormerResultSchema.safeParse({
      questions: [{ id: "", text: "What is the goal?" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a question with empty text", () => {
    const result = BrainstormerResultSchema.safeParse({
      questions: [{ id: "q1", text: "" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("RoleSchema", () => {
  it("accepts brainstormer as a valid role", () => {
    const result = RoleSchema.safeParse("brainstormer");
    expect(result.success).toBe(true);
  });
});
