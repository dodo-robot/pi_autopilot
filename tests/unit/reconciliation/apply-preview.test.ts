import { describe, expect, it } from "vitest";
import { confirmMenu } from "../../../src/reconciliation/apply-preview.js";

describe("confirmMenu", () => {
  it("maps y to apply, n to skip, a to all, q to abort", async () => {
    const inputs = ["y", "n", "a", "q", "n"];
    const readIndex = { value: 0 };
    const read = (): Promise<string> => {
      const input = inputs[readIndex.value];
      readIndex.value++;
      return Promise.resolve(input ?? "");
    };
    const abort: string[] = [];
    const write = (s: string): void => { abort.push(s); };
    expect(await confirmMenu("apply #15? ", write, read)).toBe("apply");
    expect(await confirmMenu("apply #16? ", write, read)).toBe("skip");
    expect(await confirmMenu("apply #17? ", write, read)).toBe("all");
    expect(await confirmMenu("apply #18? ", write, read)).toBe("abort");
    expect(abort).toHaveLength(4);
  });

  it("treats blank/empty input as skip (a stray Enter never applies)", async () => {
    const read = (): Promise<string> => Promise.resolve("");
    expect(await confirmMenu("x? ", () => {}, read)).toBe("skip");
  });

  it("is case-insensitive and accepts the word forms", async () => {
    const read = (): Promise<string> => Promise.resolve("APPLY");
    expect(await confirmMenu("x? ", () => {}, read)).toBe("apply");
  });

  it("loops until a valid answer", async () => {
    const inputs = ["zz", "\n", "Y"];
    const readIndex = { value: 0 };
    const read = (): Promise<string> => {
      const input = inputs[readIndex.value];
      readIndex.value++;
      return Promise.resolve(input ?? "");
    };
    const writes: string[] = [];
    expect(await confirmMenu("? ", (s) => { writes.push(s); }, read)).toBe("apply");
    // wrote the invalid-input retry prompt at least once
    expect(writes.some((s) => s.includes("apply") || s.includes("skip"))).toBe(true);
  });
});
