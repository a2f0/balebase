import { z } from "zod";

export const criterionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  prompt: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  gates: z.array(z.string()).default([]),
});
export type Criterion = z.infer<typeof criterionSchema>;

export const evaluationResultSchema = z.object({
  passed: z.boolean(),
  criteriaResults: z.array(
    z.object({
      criterionId: z.string(),
      passed: z.boolean(),
      evaluated: z.boolean(),
      feedback: z.string().min(1),
    }),
  ),
});
export type CriterionResult = z.infer<
  typeof evaluationResultSchema
>["criteriaResults"][number];

export const configSchema = z.object({
  apiUrl: z.string().url(),
  projectId: z.string(),
  codebaseId: z.string(),
  revisionId: z.string(),
  commit: z.string(),
});

export const suiteSchema = z.object({
  id: z.string(),
  description: z.string(),
  criteria: z.array(criterionSchema).min(1),
  tasks: z
    .array(
      z.object({
        id: z.string(),
        prompt: z.string().min(1),
        criteria: z.array(z.string()).min(1),
      }),
    )
    .min(1),
});
export type Suite = z.infer<typeof suiteSchema>;
