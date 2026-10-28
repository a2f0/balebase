import type { AuditDefinition } from "@balebase/validators/audits";
import { z } from "zod";
import nfpa70eData from "../auditLibrary/nfpa70e.json";
import residentialData from "../auditLibrary/residential.json";
import { parseAuditDefinition } from "./auditDefinition";
import { auditLibraryActor } from "./auditTemplates";

/**
 * Built-in global templates. The API never reads this module: migrations
 * generated from it by scripts/auditLibraryMigration.ts seed the database.
 */
export interface StarterTemplate {
  definition: AuditDefinition;
  description: string;
  id: string;
  name: string;
  publishedAt: string;
  version: number;
}

const ControlSchema = z.strictObject({
  id: z.string().min(1),
  prompt: z.string().min(1),
});

const TemplateFields = {
  id: z.string().regex(/^[a-z0-9_]+$/),
  version: z.int().positive(),
  publishedAt: z.iso.datetime({ precision: 3 }),
  name: z.string().min(1).max(200),
  description: z.string().max(2_000),
};

const ChecklistSchema = z.strictObject({
  ...TemplateFields,
  sections: z.array(
    z.strictObject({
      id: z.string().min(1),
      title: z.string().min(1),
      controls: z.array(ControlSchema),
    }),
  ),
});

const SourceReferenceSchema = z.strictObject({
  sourceId: z.string().min(1),
  locator: z.string().min(1),
});

const RiskSchema = z.strictObject({
  priority: z.enum(["critical", "high", "medium", "low"]),
  stopWorkCandidate: z.boolean(),
});

const MetadataFields = {
  applicability: z.string().min(1),
  guidance: z.string().min(1),
  evidence: z.array(z.string().min(1)).min(1),
  domains: z.array(z.string()).min(1),
  hazards: z.array(z.string()),
  phases: z.array(z.string()).min(1),
  questionClass: z.string(),
  verificationMethods: z.array(z.string()).min(1),
};

const LibrarySchema = z.strictObject({
  ...TemplateFields,
  taxonomy: z.strictObject({
    workCategories: z.array(z.string()),
    domains: z.array(z.string()),
    hazards: z.array(z.string()),
    phases: z.array(z.string()),
    questionClasses: z.array(z.string()),
    verificationMethods: z.array(z.string()),
  }),
  sources: z.array(
    z.strictObject({
      id: z.string().min(1),
      title: z.string().min(1),
      authority: z.enum([
        "federal-regulation",
        "federal-guidance",
        "model-code",
        "industry-reference",
        "project-requirement",
      ]),
      jurisdiction: z.enum(["project", "us-federal", "us-model"]),
      copyrightUse: z.enum([
        "government-work",
        "reference-only",
        "project-supplied",
      ]),
      version: z.string().min(1),
      reviewedAt: z.iso.date(),
      url: z.string().optional(),
      notes: z.string().min(1),
    }),
  ),
  sections: z.array(
    z.strictObject({
      id: z.string().min(1),
      title: z.string().min(1),
      category: z.string(),
      // Each control inherits these unless it sets the field itself.
      defaults: z.strictObject({
        ...MetadataFields,
        risk: RiskSchema,
        sourceRefs: z.array(SourceReferenceSchema).min(1),
      }),
      controls: z.array(
        ControlSchema.extend({
          ...z.object(MetadataFields).partial().shape,
          risk: RiskSchema.partial().optional(),
          // Added to the section's sourceRefs rather than replacing them.
          additionalSourceRefs: z.array(SourceReferenceSchema).optional(),
        }),
      ),
    }),
  ),
});

type Library = z.infer<typeof LibrarySchema>;
type LibrarySection = Library["sections"][number];
type SourceReference = z.infer<typeof SourceReferenceSchema>;

interface Control extends z.infer<typeof ControlSchema> {
  applicability: string;
  category: string;
  domains: string[];
  evidence: string[];
  guidance: string;
  hazards: string[];
  phases: string[];
  questionClass: string;
  risk: z.infer<typeof RiskSchema>;
  sourceRefs: SourceReference[];
  verificationMethods: string[];
}

/** A section's controls with their section defaults applied. */
function libraryControls(section: LibrarySection): Control[] {
  const { defaults } = section;
  return section.controls.map((control) => ({
    applicability: control.applicability ?? defaults.applicability,
    category: section.category,
    domains: control.domains ?? defaults.domains,
    evidence: control.evidence ?? defaults.evidence,
    guidance: control.guidance ?? defaults.guidance,
    hazards: control.hazards ?? defaults.hazards,
    id: control.id,
    phases: control.phases ?? defaults.phases,
    prompt: control.prompt,
    questionClass: control.questionClass ?? defaults.questionClass,
    risk: {
      priority: control.risk?.priority ?? defaults.risk.priority,
      stopWorkCandidate:
        control.risk?.stopWorkCandidate ?? defaults.risk.stopWorkCandidate,
    },
    sourceRefs: [
      ...defaults.sourceRefs,
      ...(control.additionalSourceRefs ?? []),
    ],
    verificationMethods:
      control.verificationMethods ?? defaults.verificationMethods,
  }));
}

/** Schema and content errors in residential library data, if any. */
export function validateResidentialLibrary(data: unknown = residentialData) {
  const parsed = LibrarySchema.safeParse(data);
  if (!parsed.success) {
    return parsed.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
  }
  const errors: string[] = [];
  const sourceIds = validateSources(errors, parsed.data);
  validateSections(errors, parsed.data, sourceIds);
  return errors;
}

export function residentialLibraryStats() {
  const library = LibrarySchema.parse(residentialData);
  const controls = library.sections.flatMap(libraryControls);
  return {
    controls: controls.length,
    criticalControls: controls.filter(
      (control) => control.risk.priority === "critical",
    ).length,
    sections: library.sections.length,
    sources: library.sources.length,
  };
}

function validateSources(errors: string[], library: Library) {
  const ids = new Set<string>();
  for (const source of library.sources) {
    if (ids.has(source.id)) errors.push(`Duplicate source id: ${source.id}`);
    ids.add(source.id);
    if (source.url !== undefined && !source.url.startsWith("https://")) {
      errors.push(`Source URL must use HTTPS: ${source.id}`);
    }
  }
  return ids;
}

function validateSections(
  errors: string[],
  library: Library,
  sourceIds: Set<string>,
) {
  const categories = new Set<string>();
  const sectionIds = new Set<string>();
  const controlIds = new Set<string>();
  const referencedSourceIds = new Set<string>();
  for (const section of library.sections) {
    if (sectionIds.has(section.id)) {
      errors.push(`Duplicate section id: ${section.id}`);
    }
    sectionIds.add(section.id);
    if (!library.taxonomy.workCategories.includes(section.category)) {
      errors.push(`Unknown category for section: ${section.id}`);
    }
    if (categories.has(section.category)) {
      errors.push(`Duplicate category section: ${section.category}`);
    }
    categories.add(section.category);
    if (section.controls.length === 0 || section.controls.length > 100) {
      errors.push(`Invalid control count for section: ${section.id}`);
    }
    validateAdditionalReferences(errors, section);
    for (const control of libraryControls(section)) {
      validateControl(errors, library, controlIds, control);
      validateReferences(errors, sourceIds, referencedSourceIds, control);
    }
  }
  for (const category of library.taxonomy.workCategories) {
    if (!categories.has(category)) errors.push(`Missing category: ${category}`);
  }
  for (const sourceId of sourceIds) {
    if (!referencedSourceIds.has(sourceId)) {
      errors.push(`Unused source: ${sourceId}`);
    }
  }
}

function validateAdditionalReferences(
  errors: string[],
  section: LibrarySection,
) {
  for (const control of section.controls) {
    const seen = new Set(section.defaults.sourceRefs.map(referenceKey));
    for (const reference of control.additionalSourceRefs ?? []) {
      if (seen.has(referenceKey(reference))) {
        errors.push(`Repeated source reference on ${control.id}`);
      }
      seen.add(referenceKey(reference));
    }
  }
}

function referenceKey(reference: SourceReference) {
  return `${reference.sourceId}\n${reference.locator}`;
}

function validateControl(
  errors: string[],
  { taxonomy }: Library,
  controlIds: Set<string>,
  control: Control,
) {
  if (controlIds.has(control.id)) {
    errors.push(`Duplicate control id: ${control.id}`);
  }
  controlIds.add(control.id);
  if (!/^res-[a-z]+-[0-9]{3}$/.test(control.id)) {
    errors.push(`Invalid control id: ${control.id}`);
  }
  if (control.prompt.length > 500) {
    errors.push(`Invalid prompt length: ${control.id}`);
  }
  const unknown = [
    ...control.domains.filter((value) => !taxonomy.domains.includes(value)),
    ...control.hazards.filter((value) => !taxonomy.hazards.includes(value)),
    ...control.phases.filter((value) => !taxonomy.phases.includes(value)),
    ...control.verificationMethods.filter(
      (value) => !taxonomy.verificationMethods.includes(value),
    ),
    ...[control.questionClass].filter(
      (value) => !taxonomy.questionClasses.includes(value),
    ),
  ];
  if (unknown.length > 0) {
    errors.push(`Unknown taxonomy on ${control.id}: ${unknown.join(", ")}`);
  }
  if (control.risk.stopWorkCandidate && control.risk.priority !== "critical") {
    errors.push(`Stop-work candidate is not critical: ${control.id}`);
  }
}

function validateReferences(
  errors: string[],
  sourceIds: Set<string>,
  referencedSourceIds: Set<string>,
  control: Control,
) {
  for (const reference of control.sourceRefs) {
    referencedSourceIds.add(reference.sourceId);
    if (!sourceIds.has(reference.sourceId)) {
      errors.push(`Unknown source ${reference.sourceId} on ${control.id}`);
    }
  }
}

/** The starter templates in seeding order, validated and compiled. */
export function starterTemplates(): StarterTemplate[] {
  const errors = validateResidentialLibrary();
  if (errors.length > 0) {
    throw new Error(`Invalid residential library:\n${errors.join("\n")}`);
  }
  return [
    compileStarter(ChecklistSchema.parse(nfpa70eData)),
    compileStarter(LibrarySchema.parse(residentialData)),
  ];
}

/** Serves every control as a required Pass/Fail/N/A check. */
function compileStarter(
  template: z.infer<typeof ChecklistSchema>,
): StarterTemplate {
  const definition: AuditDefinition = {
    sections: template.sections.map((section) => ({
      id: section.id,
      items: section.controls.map((control) => ({
        id: control.id,
        prompt: control.prompt,
        required: true,
        responseType: "check",
      })),
      title: section.title,
    })),
    version: 1,
  };
  const served = parseAuditDefinition(definition);
  if (JSON.stringify(served) !== JSON.stringify(definition)) {
    throw new Error(`The audit API would reject or alter ${template.id}.`);
  }
  return {
    definition,
    description: template.description,
    id: template.id,
    name: template.name,
    publishedAt: template.publishedAt,
    version: template.version,
  };
}

// D1 rejects longer statements.
const maxStatementBytes = 100_000;

export function starterSeedKey({ id, version }: StarterTemplate) {
  return `${id} v${version}`;
}

/**
 * The SQL that publishes a starter version. The first version is skipped
 * where the request-time seeding of earlier releases already stored it; a
 * later version fails if that version number already exists on the tier.
 */
export function starterTemplateSql(template: StarterTemplate) {
  const { id, publishedAt, version } = template;
  const actor = sqlText(auditLibraryActor.id);
  const insertVersion = `INSERT ${version === 1 ? "OR IGNORE " : ""}INTO audit_template_versions
  (id, template_id, version, name, description, definition, status,
   created_by, created_at)
VALUES
  (${sqlText(`${id}:v${version}`)}, ${sqlText(id)}, ${version},
   ${sqlText(template.name)},
   ${sqlText(template.description)},
   ${sqlText(JSON.stringify(template.definition))},
   'published', ${actor}, ${sqlText(publishedAt)});`;
  const statements =
    version === 1
      ? [
          `INSERT OR IGNORE INTO audit_template_families
  (id, scope, organization_id, current_version, created_by, created_at,
   updated_at)
VALUES
  (${sqlText(id)}, 'global', NULL, 1, ${actor},
   ${sqlText(publishedAt)}, ${sqlText(publishedAt)});`,
          insertVersion,
        ]
      : [
          insertVersion,
          `UPDATE audit_template_families
SET current_version = ${version}, updated_at = ${sqlText(publishedAt)}
WHERE id = ${sqlText(id)} AND current_version < ${version};`,
        ];
  for (const statement of statements) {
    if (new TextEncoder().encode(statement).length > maxStatementBytes) {
      throw new Error(`${id} v${version} exceeds D1's statement size limit.`);
    }
  }
  return [`-- audit-library: ${starterSeedKey(template)}`, ...statements].join(
    "\n",
  );
}

export function starterMigrationSql(templates: StarterTemplate[]) {
  const header = `-- Generated by \`bun run --cwd packages/api audit-library:migration\` from
-- packages/api/auditLibrary. Do not edit: change the data, raise the
-- template's version, and generate a new migration.`;
  return `${[header, ...templates.map(starterTemplateSql)].join("\n\n")}\n`;
}

/** Each starter version a migration seeds, with that migration's SQL. */
export function seededStarterVersions(
  migrations: Array<{ filename: string; sql: string }>,
) {
  const seeded = new Map<string, { filename: string; sql: string }>();
  for (const { filename, sql } of migrations) {
    for (const block of sql.split(/^(?=-- audit-library: )/m).slice(1)) {
      const key = block.slice("-- audit-library: ".length, block.indexOf("\n"));
      if (seeded.has(key)) throw new Error(`${key} is seeded twice.`);
      seeded.set(key, { filename, sql: block.trim() });
    }
  }
  return seeded;
}

/**
 * The test database splits migrations at lines ending in a semicolon and
 * drops comment lines, so literals must stay on one line.
 */
function sqlText(value: string) {
  if (/[\r\n]/.test(value)) throw new Error("SQL text must be one line.");
  return `'${value.replaceAll("'", "''")}'`;
}
