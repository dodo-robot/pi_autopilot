import { describe, expect, it } from "vitest";
import { buildBootstrapperPrompt } from "../../../src/bootstrap/bootstrapper-prompt.js";

describe("buildBootstrapperPrompt", () => {
  it("returns a non-empty string containing key instructions", () => {
    const prompt = buildBootstrapperPrompt({
      repository: { owner: "acme", repo: "widgets" },
      requirementDocs: [{ path: "requirements.md", content: "## Auth\nUsers must log in." }],
      hasExistingConfig: false,
    });
    expect(prompt.length).toBeGreaterThan(100);
    expect(prompt).toContain("submit_result");
    expect(prompt).toContain("brainstorming");
    expect(prompt).toContain("dependency");
    expect(prompt).toContain("tracks");
    expect(prompt).toContain("ask_human");
    expect(prompt).toContain("human-in-the-loop");
  });

  it("lists existing open epic titles verbatim and instructs reuse when scope matches", () => {
    const prompt = buildBootstrapperPrompt({
      repository: { owner: "acme", repo: "widgets" },
      requirementDocs: [{ path: "requirements.md", content: "## Auth\nUsers must log in." }],
      hasExistingConfig: false,
      existingEpicTitles: ["M1 — Data Ingestion & Staging", "M2 — Motore di Calcolo"],
    });
    expect(prompt).toContain("M1 — Data Ingestion & Staging");
    expect(prompt).toContain("M2 — Motore di Calcolo");
    expect(prompt).toContain("exact");
  });

  it("instructs the bootstrapper to use module-code plus sequence numbering for issue titles", () => {
    const prompt = buildBootstrapperPrompt({
      repository: { owner: "acme", repo: "widgets" },
      requirementDocs: [{ path: "requirements.md", content: "## Auth\nUsers must log in." }],
      hasExistingConfig: false,
    });
    expect(prompt).toContain("MODULE-##");
    expect(prompt).toContain("M1-01");
    expect(prompt).toContain("RNF-01");
    expect(prompt).toContain("CRUE-01");
  });

  it("lists existing open leaf issues and instructs reuse by requirement code before creating a new issue", () => {
    const prompt = buildBootstrapperPrompt({
      repository: { owner: "acme", repo: "widgets" },
      requirementDocs: [{ path: "requirements.md", content: "## Auth\nUsers must log in." }],
      hasExistingConfig: false,
      existingLeafIssues: [
        { number: 123, title: "M1-13 Scorporo cespite in sotto-cespiti", requirementCodes: ["RF-M1-030"] },
        { number: 456, title: "CRUE-08 Parametri di sicurezza e sessione", requirementCodes: ["CRUE-08"] },
      ],
    });
    expect(prompt).toContain("#123");
    expect(prompt).toContain("RF-M1-030");
    expect(prompt).toContain("CRUE-08");
    expect(prompt).toMatch(/reuse.*existing open issue/i);
    expect(prompt).toMatch(/requirement code/i);
  });

  it("says no open epics exist yet when the list is empty", () => {
    const prompt = buildBootstrapperPrompt({
      repository: { owner: "acme", repo: "widgets" },
      requirementDocs: [{ path: "requirements.md", content: "## Auth\nUsers must log in." }],
      hasExistingConfig: false,
      existingEpicTitles: [],
    });
    expect(prompt).toMatch(/no (existing )?(open )?epics/i);
  });
});
