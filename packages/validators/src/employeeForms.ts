import { z } from "zod";

export const EmployeeRequirementKindSchema = z.enum([
  "form",
  "background_check",
  "credit_check",
]);
export type EmployeeRequirementKind = z.infer<
  typeof EmployeeRequirementKindSchema
>;

export const EmployeeRequirementStatusSchema = z.enum([
  "pending",
  "in_progress",
  "submitted",
  "complete",
]);
export type EmployeeRequirementStatus = z.infer<
  typeof EmployeeRequirementStatusSchema
>;

export const employeeFormsRoutes = {};
