import { randomBytes } from "node:crypto";
import type { ArtifactStore } from "../persistence/artifact-store.js";
import { type BootstrapPlan, BootstrapPlanSchema } from "./types.js";

const PLAN_ARTIFACT = "plan.json";

export function generatePlanId(now = new Date()): string {
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const hex = randomBytes(6).toString("hex");
  return `bootstrap-${date}-${hex}`;
}

export class PlanStore {
  constructor(private readonly artifacts: ArtifactStore) {}

  async save(plan: BootstrapPlan): Promise<void> {
    await this.artifacts.writeJson(plan.planId, PLAN_ARTIFACT, plan);
  }

  async update(plan: BootstrapPlan): Promise<void> {
    await this.artifacts.writeJson(plan.planId, PLAN_ARTIFACT, plan);
  }

  async load(planId: string): Promise<BootstrapPlan> {
    const raw = await this.artifacts.readJson(planId, PLAN_ARTIFACT);
    const parsed = BootstrapPlanSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`invalid plan artifact for ${planId}: ${parsed.error.message}`);
    }
    return parsed.data;
  }
}
