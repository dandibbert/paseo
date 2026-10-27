import { z } from "zod";

export const ProviderCliUpdatePlanSchema = z.object({
  token: z.string(),
  provider: z.string(),
  hostname: z.string(),
  binaryPath: z.string(),
  currentVersion: z.string(),
  latestVersion: z.string(),
  updateMethod: z.string().optional(),
  command: z.array(z.string()),
  updatedCommand: z.array(z.string()).optional(),
});

export const ProviderCliUpdateInspectionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), plan: ProviderCliUpdatePlanSchema }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);

export const ProviderCliUpdateResultSchema = z.object({
  success: z.boolean(),
  version: z.string().nullable(),
  output: z.string(),
  error: z.string().nullable(),
});

export type ProviderCliUpdatePlan = z.infer<typeof ProviderCliUpdatePlanSchema>;
export type ProviderCliUpdateInspection = z.infer<typeof ProviderCliUpdateInspectionSchema>;
export type ProviderCliUpdateResult = z.infer<typeof ProviderCliUpdateResultSchema>;
