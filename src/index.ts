#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { lookup } from "mime-types";
import {
  TextualClient,
  type Dataset,
  type GeneratorConfig,
  type GeneratorHandling,
  type GeneratorMetadataEntry,
  type ModelBasedEntityAnnotationSpan,
  type ModelBasedEntityDetectedEntityApiModel,
  type JsonRedactOptions,
  type LabelCustomList,
  type ModelBasedEntityApiModel,
  type ModelBasedEntityFileFullApiModel,
  type ModelBasedEntityFileMinimalApiModel,
  type ModelBasedEntityFileVersionRecordWithAnnotations,
  type ModelBasedEntityModelTrainingFileApiModel,
  type ModelBasedEntityModelTrainingFileFullApiModel,
  type ModelBasedEntityTrainingFileApiModel,
  type ModelBasedEntityTrainingFileFullApiModel,
  type ModelBasedEntityTrainedModelApiModel,
  type ModelBasedEntityVersionApiModel,
  type RedactOptions,
} from "./textual-client.js";
import { Logger, withLogging } from "./logger.js";

const BASE_URL = process.env.TONIC_TEXTUAL_BASE_URL || "https://textual.tonic.ai";
const API_KEY = process.env.TONIC_TEXTUAL_API_KEY;

if (!API_KEY) {
  console.error("TONIC_TEXTUAL_API_KEY environment variable is required");
  process.exit(1);
}

const logger = new Logger();
const MAX_CONCURRENT = parseInt(process.env.TONIC_TEXTUAL_MAX_CONCURRENT_REQUESTS || "50", 10);
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_S = parseInt(process.env.TONIC_TEXTUAL_POLL_TIMEOUT_SECONDS || "900", 10);
const client = new TextualClient(BASE_URL, API_KEY, logger, MAX_CONCURRENT);

// --- Shared schemas ---

const generatorHandlingEnum = z
  .enum(["Redaction", "Synthesis", "GroupingSynthesis", "ReplacementSynthesis", "Off"])
  .describe("How to handle a detected entity type");

const generatorConfigSchema = z
  .record(z.string(), generatorHandlingEnum)
  .optional()
  .describe(
    "Per-entity-type handling. Keys are entity types (e.g. NAME_GIVEN, US_SSN, ORGANIZATION). Values are handling options."
  );

const generatorDefaultSchema = generatorHandlingEnum
  .optional()
  .describe("Default handling for entity types not specified in generatorConfig");

const labelCustomListSchema = z.object({
  strings: z.array(z.string()).optional().describe("Literal strings to match"),
  regexes: z.array(z.string()).optional().describe("Regex patterns to match"),
});

const labelBlockListsSchema = z
  .record(z.string(), labelCustomListSchema)
  .optional()
  .describe(
    "Per-entity-type block lists. Keys are entity types. Values contain regex/string patterns. Matched values are excluded from detection."
  );

const labelAllowListsSchema = z
  .record(z.string(), labelCustomListSchema)
  .optional()
  .describe(
    "Per-entity-type allow lists. Keys are entity types. Values contain regex/string patterns. Matched values are force-detected as that entity type."
  );

const generatorMetadataSchema = z
  .record(
    z.string(),
    z.object({
      version: z.enum(["V1", "V2"]).optional().describe("Generator version. V2 is length-aware."),
      customGenerator: z
        .string()
        .optional()
        .describe("Custom generator override (e.g. Scramble, Email, Name, Ssn, CreditCard, PhoneNumber, DateTime, etc.)"),
      swaps: z
        .record(z.string(), z.string())
        .optional()
        .describe("Deterministic substitution map: original value → replacement value"),
    })
  )
  .optional()
  .describe("Per-entity-type synthesis metadata. Keys are entity types. Controls generator version, custom generators, and value swaps.");

const customEntitiesSchema = z
  .array(z.string())
  .optional()
  .describe("Custom PII entity identifiers to use for detection (e.g. ['CUSTOM_ENTITY_1'])");

const redactOptionSchemas = {
  generatorConfig: generatorConfigSchema,
  generatorDefault: generatorDefaultSchema,
  generatorMetadata: generatorMetadataSchema,
  customEntities: customEntitiesSchema,
  labelBlockLists: labelBlockListsSchema,
  labelAllowLists: labelAllowListsSchema,
};

const modelBasedEntityIdSchema = z.string().describe("The model-based entity ID");

const modelBasedEntityVersionIdSchema = z.string().describe("The entity version ID");

const modelBasedEntityNameSchema = z
  .string()
  .describe("Human-readable name for the model-based entity");

const modelBasedEntityGuidelinesSchema = z
  .string()
  .describe("Guidelines that define how Textual should identify this model-based entity");

const modelBasedEntityFileIdSchema = z.string().describe("The model-based entity file ID");

const trainedModelIdSchema = z.string().describe("The trained model ID");

const datasetIdSchema = z.string().describe("The dataset ID");

const modelBasedEntityAnnotationSpanSchema = z.object({
  start: z.number().int().nonnegative().describe("Inclusive character start offset for the annotation span"),
  end: z.number().int().nonnegative().describe("Exclusive character end offset for the annotation span"),
});

const entityFileSearchSchema = z
  .string()
  .optional()
  .describe("Optional search text to filter entity training files by file name or related indexed metadata");

const modelDetectedEntitySearchSchema = z
  .string()
  .optional()
  .describe("Optional search text to filter detected entity values by name");

const customEntitySearchSchema = z
  .string()
  .optional()
  .describe("Optional search text to filter the paginated custom-entity list by name or related indexed metadata");

const paginationOffsetSchema = z.number().int().nonnegative().optional().describe("Zero-based offset into the paginated results");

const paginationLimitSchema = z.number().int().positive().optional().describe("Maximum number of results to return");

const customEntityUsersSchema = z
  .array(z.string())
  .optional()
  .describe("Optional user identifiers to filter the paginated custom-entity list");

const modelBasedEntityStatusesSchema = z
  .array(z.string())
  .optional()
  .describe("Optional model-based entity lifecycle statuses to filter the paginated custom-entity list");

const customEntitySortBySchema = z
  .string()
  .optional()
  .describe("Optional server-side sort field for the paginated custom-entity list");

const customEntitySortDirectionSchema = z
  .string()
  .optional()
  .describe("Optional server-side sort direction for the paginated custom-entity list");

function jsonTextResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function summarizeModelBasedEntity(entity: ModelBasedEntityApiModel) {
  return {
    entityId: entity.id,
    name: entity.name,
    displayName: entity.displayName,
    status: entity.status,
    activeModelId: entity.activeModelId,
    datasetIds: entity.datasetIds,
    lastModifiedDate: entity.lastModifiedDate,
  };
}

function summarizeModelBasedEntityDetails(entity: ModelBasedEntityApiModel) {
  return {
    ...summarizeModelBasedEntity(entity),
    fileSource: entity.fileSource,
    createdByUserId: entity.createdByUserId,
  };
}

function summarizeEntityVersion(
  version: ModelBasedEntityVersionApiModel,
  options: { includeGuidelines?: boolean; includeFiles?: boolean } = {}
) {
  return {
    versionId: version.id,
    entityId: version.entityId,
    versionNumber: version.versionNumber,
    status: version.status,
    ...(options.includeGuidelines ? { guidelines: version.guidelines } : {}),
    entityCount: version.entityCount,
    f1Score: version.f1Score,
    recallScore: version.recallScore,
    precisionScore: version.precisionScore,
    fileCount: version.files.length,
    errorType: version.errorType,
    errorDetails: version.errorDetails,
    ...(options.includeFiles
      ? {
          files: version.files.map((file) => ({
            versionFileId: file.id,
            fileId: file.fileId,
            fileName: file.fileName,
            status: file.status,
            numEntities: file.numEntities,
            f1Score: file.f1Score,
            recallScore: file.recallScore,
            precisionScore: file.precisionScore,
            errorType: file.errorType,
            errorDetails: file.errorDetails,
            createdAt: file.createdAt,
          })),
        }
      : {}),
  };
}

function summarizeTrainedModel(model: ModelBasedEntityTrainedModelApiModel) {
  return {
    modelId: model.id,
    modelNumber: model.number,
    entityId: model.entityId,
    versionId: model.versionId,
    status: model.status,
    isActive: model.isActive,
    progress: model.progress,
    benchmarkScore: model.benchmarkScore,
    entityCount: model.entityCount,
    fileCount: model.fileCount,
  };
}

function summarizeEntityTestFile(entityId: string, file: ModelBasedEntityFileMinimalApiModel) {
  return {
    entityId,
    fileId: file.id,
    fileName: file.fileName,
    filePath: file.filePath,
    minimumVersionId: file.minimumVersionId,
    status: file.status,
    errorType: file.errorType,
    errorDetails: file.errorDetails,
    createdAt: file.createdAt,
  };
}

function summarizeSavedGroundTruth(entityId: string, fileId: string, file: ModelBasedEntityFileFullApiModel | null) {
  if (!file) {
    return {
      entityId,
      fileId,
      message: "Ground truth saved.",
    };
  }

  return {
    ...summarizeEntityTestFile(entityId, file),
    groundTruthCount: file.groundTruth.length,
    groundTruth: file.groundTruth,
    message: "Ground truth saved.",
  };
}

function summarizeEntityTrainingFile(file: ModelBasedEntityTrainingFileApiModel) {
  return {
    entityId: file.entityId,
    fileId: file.id,
    fileName: file.fileName,
    filePath: file.filePath,
    status: file.status,
    createdAt: file.createdAt,
  };
}

function summarizeEntityTrainingFileDetails(file: ModelBasedEntityTrainingFileFullApiModel) {
  return {
    ...summarizeEntityTrainingFile(file),
    deleted: file.deleted,
    content: file.content,
  };
}

function summarizeModelTrainingFile(file: ModelBasedEntityModelTrainingFileApiModel) {
  const details = file as Record<string, unknown>;
  return {
    modelTrainingFileId: file.id,
    fileId: file.fileId,
    fileName: file.fileName,
    createdAt: file.createdAt,
    deleted: file.deleted,
    ...(typeof file.numEntities === "number" ? { numEntities: file.numEntities } : {}),
    ...(typeof details.status === "string" ? { status: details.status } : {}),
  };
}

function summarizeModelTrainingFileDetails(file: ModelBasedEntityModelTrainingFileFullApiModel) {
  return {
    ...summarizeModelTrainingFile(file),
    annotationCount: file.annotations.length,
    content: file.content,
    annotations: file.annotations,
  };
}

function summarizeModelDetectedEntity(entity: ModelBasedEntityDetectedEntityApiModel) {
  return {
    name: entity.name,
    count: entity.count,
  };
}

function summarizeEntityTestFileDeletion(entityId: string, fileId: string, response: unknown) {
  if (
    response &&
    typeof response === "object" &&
    "id" in response &&
    typeof response.id === "string" &&
    "minimumVersionId" in response
  ) {
    const file = response as ModelBasedEntityFileMinimalApiModel;
    return {
      ...summarizeEntityTestFile(entityId, file),
      deleted: file.deleted,
      message: "Entity test file deleted.",
    };
  }

  if (response && typeof response === "object") {
    const details = response as Record<string, unknown>;
    return {
      entityId,
      fileId,
      status: typeof details.status === "string" ? details.status : "accepted",
      ...(Object.keys(details).length > 0 ? { details } : {}),
      message: "Entity test file delete request submitted.",
    };
  }

  return {
    entityId,
    fileId,
    status: "accepted",
    message: "Entity test file delete request submitted.",
  };
}

function summarizeEntityTrainingFileDeletion(entityId: string, fileId: string, response: unknown) {
  if (
    response &&
    typeof response === "object" &&
    "id" in response &&
    typeof response.id === "string" &&
    "entityId" in response
  ) {
    const file = response as ModelBasedEntityTrainingFileApiModel;
    return {
      ...summarizeEntityTrainingFile(file),
      deleted: file.deleted,
      message: "Entity training file deleted.",
    };
  }

  if (response && typeof response === "object") {
    const details = response as Record<string, unknown>;
    return {
      entityId,
      fileId,
      status: typeof details.status === "string" ? details.status : "accepted",
      ...(Object.keys(details).length > 0 ? { details } : {}),
      message: "Entity training file delete request submitted.",
    };
  }

  return {
    entityId,
    fileId,
    status: "accepted",
    message: "Entity training file delete request submitted.",
  };
}

function summarizeEntityFileAnnotations(file: ModelBasedEntityFileVersionRecordWithAnnotations) {
  return {
    versionFileId: file.id,
    fileId: file.fileId,
    versionId: file.versionId,
    fileName: file.fileName,
    filePath: file.filePath,
    status: file.status,
    numEntities: file.numEntities,
    f1Score: file.f1Score,
    recallScore: file.recallScore,
    precisionScore: file.precisionScore,
    errorType: file.errorType,
    errorDetails: file.errorDetails,
    createdAt: file.createdAt,
    annotationCount: file.annotations.length,
    content: file.content,
    annotations: file.annotations,
  };
}

async function resolveLatestEntityVersionId(entityId: string): Promise<string> {
  const versions = await client.listEntityVersions(entityId);
  const latestVersion = versions.reduce<ModelBasedEntityVersionApiModel | null>((currentLatest, version) => {
    if (!currentLatest || version.versionNumber > currentLatest.versionNumber) {
      return version;
    }

    return currentLatest;
  }, null);

  if (!latestVersion) {
    throw new Error(`No versions found for entity ${entityId}`);
  }

  return latestVersion.id;
}

function summarizeEntityDatasetActivation(entityId: string, datasetId: string, response: unknown) {
  if (
    response &&
    typeof response === "object" &&
    "id" in response &&
    typeof response.id === "string" &&
    "status" in response &&
    typeof response.status === "string"
  ) {
    return {
      datasetId,
      ...summarizeModelBasedEntity(response as ModelBasedEntityApiModel),
      message: "Entity activated for dataset.",
    };
  }

  if (response && typeof response === "object") {
    const details = response as Record<string, unknown>;
    return {
      entityId,
      datasetId,
      status: typeof details.status === "string" ? details.status : "accepted",
      ...(Object.keys(details).length > 0 ? { details } : {}),
      message: "Entity activated for dataset.",
    };
  }

  return {
    entityId,
    datasetId,
    status: "accepted",
    message: "Entity activated for dataset.",
  };
}

function summarizeEntityDatasetDeactivation(entityId: string, datasetId: string, response: unknown) {
  if (
    response &&
    typeof response === "object" &&
    "id" in response &&
    typeof response.id === "string" &&
    "status" in response &&
    typeof response.status === "string"
  ) {
    return {
      datasetId,
      ...summarizeModelBasedEntity(response as ModelBasedEntityApiModel),
      message: "Entity deactivated for dataset.",
    };
  }

  if (response && typeof response === "object") {
    const details = response as Record<string, unknown>;
    return {
      entityId,
      datasetId,
      status: typeof details.status === "string" ? details.status : "accepted",
      ...(Object.keys(details).length > 0 ? { details } : {}),
      message: "Entity deactivated for dataset.",
    };
  }

  return {
    entityId,
    datasetId,
    status: "accepted",
    message: "Entity deactivated for dataset.",
  };
}

function summarizeAsyncModelAction(action: string, entityId: string, modelId: string, response: unknown) {
  if (response && typeof response === "object") {
    if (
      "id" in response &&
      typeof response.id === "string" &&
      "status" in response &&
      typeof response.status === "string"
    ) {
      return {
        action,
        ...summarizeTrainedModel(response as ModelBasedEntityTrainedModelApiModel),
      };
    }

    const details = response as Record<string, unknown>;
    return {
      action,
      entityId,
      modelId,
      status: typeof details.status === "string" ? details.status : "accepted",
      ...(Object.keys(details).length > 0 ? { details } : {}),
    };
  }

  return {
    action,
    entityId,
    modelId,
    status: "accepted",
  };
}

function summarizeAsyncEntityAction(action: string, entityId: string, response: unknown, message: string) {
  if (
    response &&
    typeof response === "object" &&
    "id" in response &&
    typeof response.id === "string" &&
    "status" in response &&
    typeof response.status === "string"
  ) {
    return {
      action,
      ...summarizeModelBasedEntityDetails(response as ModelBasedEntityApiModel),
      message,
    };
  }

  if (response && typeof response === "object") {
    const details = response as Record<string, unknown>;
    return {
      action,
      entityId,
      status: typeof details.status === "string" ? details.status : "accepted",
      ...(Object.keys(details).length > 0 ? { details } : {}),
      message,
    };
  }

  return {
    action,
    entityId,
    status: "accepted",
    message,
  };
}

function summarizeAsyncVersionAction(
  action: string,
  entityId: string,
  versionId: string,
  response: unknown,
  message: string
) {
  if (
    response &&
    typeof response === "object" &&
    "id" in response &&
    typeof response.id === "string" &&
    "entityId" in response &&
    typeof response.entityId === "string" &&
    "status" in response &&
    typeof response.status === "string"
  ) {
    return {
      action,
      ...summarizeEntityVersion(response as ModelBasedEntityVersionApiModel),
      message,
    };
  }

  if (response && typeof response === "object") {
    const details = response as Record<string, unknown>;
    return {
      action,
      entityId,
      versionId,
      status: typeof details.status === "string" ? details.status : "accepted",
      ...(Object.keys(details).length > 0 ? { details } : {}),
      message,
    };
  }

  return {
    action,
    entityId,
    versionId,
    status: "accepted",
    message,
  };
}

// Helper to build RedactOptions from tool params
function buildRedactOpts(params: {
  generatorConfig?: Record<string, string>;
  generatorDefault?: string;
  generatorMetadata?: Record<string, GeneratorMetadataEntry>;
  customEntities?: string[];
  labelBlockLists?: Record<string, LabelCustomList>;
  labelAllowLists?: Record<string, LabelCustomList>;
}): RedactOptions {
  return {
    generatorConfig: params.generatorConfig as GeneratorConfig | undefined,
    generatorDefault: params.generatorDefault as GeneratorHandling | undefined,
    generatorMetadata: params.generatorMetadata,
    customEntities: params.customEntities,
    labelBlockLists: params.labelBlockLists,
    labelAllowLists: params.labelAllowLists,
  };
}

// Helper: convert human-friendly durations (1h, 30m, 7d) to .NET TimeSpan format (d.HH:mm:ss)
function toTimeSpan(input: string): string {
  // Already in TimeSpan format (contains colons)
  if (input.includes(":")) return input;
  const match = input.match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!match) return input;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  let totalSeconds = 0;
  if (unit === "s") totalSeconds = value;
  else if (unit === "m") totalSeconds = value * 60;
  else if (unit === "h") totalSeconds = value * 3600;
  else if (unit === "d") totalSeconds = value * 86400;
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const hms = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return days > 0 ? `${days}.${hms}` : hms;
}

// Helper: poll for file processing completion then download
async function pollAndDownload(jobId: string, opts: RedactOptions, signal?: AbortSignal): Promise<Buffer> {
  const maxAttempts = Math.ceil(POLL_TIMEOUT_S / (POLL_INTERVAL_MS / 1000));
  for (let i = 0; i < maxAttempts; i++) {
    signal?.throwIfAborted();
    try {
      return await client.downloadRedactedFile(jobId, opts, signal);
    } catch (err: unknown) {
      // 409 means still processing — retry after delay
      if ((err as any)?.statusCode === 409) {
        logger.info("poll_retry", { jobId, attempt: i + 1, maxAttempts });
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`File processing timed out after ${POLL_TIMEOUT_S} seconds for job ${jobId}`);
}

// ============================================================
// Register all tools on an McpServer instance
// ============================================================
function registerTools(s: McpServer) {

  // --- redact_text ---
  s.tool(
    "redact_text",
    "Redact PII from a single plain text string. Returns the de-identified text and details about each detected entity. If you need to redact multiple files or an entire directory, use deidentify_folder instead — do NOT call this tool in a loop.",
    { text: z.string().describe("The text to de-identify"), ...redactOptionSchemas },
    withLogging(logger, "redact_text", async (params) => {
      const result = await client.redactText(params.text, buildRedactOpts(params));
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ redactedText: result.redactedText, entitiesFound: result.deIdentifyResults?.length ?? 0, entities: result.deIdentifyResults }, null, 2),
        }],
      };
    })
  );

  // --- redact_bulk ---
  s.tool(
    "redact_bulk",
    "Redact PII from multiple text strings in one call. Efficient for batch processing.",
    { texts: z.array(z.string()).describe("Array of text strings to de-identify"), ...redactOptionSchemas },
    withLogging(logger, "redact_bulk", async (params) => {
      const result = await client.redactBulk(params.texts, buildRedactOpts(params));
      const summary = result.bulkRedactionResults.map((r, i) => ({
        index: i, redactedText: r.redactedText, entitiesFound: r.deIdentifyResults?.length ?? 0,
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
    })
  );

  // --- redact_json ---
  s.tool(
    "redact_json",
    "Redact PII from a single JSON string. Preserves JSON structure, only redacts text values. Supports JSONPath-based allow lists and ignore paths for fine-grained control. Use this to test options on ONE sample file, then pass those same options (including jsonPathIgnorePaths/jsonPathAllowLists) to deidentify_folder to process the full directory. Do NOT call this in a loop or write a script.",
    {
      jsonText: z.string().describe("The JSON string to de-identify"),
      ...redactOptionSchemas,
      jsonPathAllowLists: z
        .record(z.string(), z.array(z.string()))
        .optional()
        .describe(
          "Map of entity type labels to arrays of JSONPath expressions. Values at these paths are force-detected as the given entity type. Example: {\"NAME_GIVEN\": [\"$.name.first\"]}"
        ),
      jsonPathIgnorePaths: z
        .array(z.string())
        .optional()
        .describe(
          "Array of JSONPath expressions for values that should NOT be redacted. Any JSON element matching these paths will be left unchanged. Example: [\"$.id\", \"$.metadata.timestamp\"]"
        ),
    },
    withLogging(logger, "redact_json", async (params) => {
      const opts: JsonRedactOptions = {
        ...buildRedactOpts(params),
        jsonPathAllowLists: params.jsonPathAllowLists,
        jsonPathIgnorePaths: params.jsonPathIgnorePaths,
      };
      const result = await client.redactJson(params.jsonText, opts);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ redactedText: result.redactedText, entitiesFound: result.deIdentifyResults?.length ?? 0, entities: result.deIdentifyResults }, null, 2),
        }],
      };
    })
  );

  // --- redact_xml ---
  s.tool(
    "redact_xml",
    "Redact PII from a single XML string. Preserves XML structure, only redacts text values and attributes. For multiple files, use deidentify_folder instead.",
    { xmlText: z.string().describe("The XML string to de-identify"), ...redactOptionSchemas },
    withLogging(logger, "redact_xml", async (params) => {
      const result = await client.redactXml(params.xmlText, buildRedactOpts(params));
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ redactedText: result.redactedText, entitiesFound: result.deIdentifyResults?.length ?? 0, entities: result.deIdentifyResults }, null, 2),
        }],
      };
    })
  );

  // --- redact_html ---
  s.tool(
    "redact_html",
    "Redact PII from a single HTML string. Preserves HTML structure, only redacts text content. For multiple files, use deidentify_folder instead.",
    { htmlText: z.string().describe("The HTML string to de-identify"), ...redactOptionSchemas },
    withLogging(logger, "redact_html", async (params) => {
      const result = await client.redactHtml(params.htmlText, buildRedactOpts(params));
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ redactedText: result.redactedText, entitiesFound: result.deIdentifyResults?.length ?? 0, entities: result.deIdentifyResults }, null, 2),
        }],
      };
    })
  );

  // --- list_pii_types ---
  s.tool(
    "list_pii_types",
    "List all PII entity types that Tonic Textual can detect. Use this to understand what entity types are available for generator_config.",
    {},
    withLogging(logger, "list_pii_types", async () => {
      const types = await client.getPiiTypes();
      return { content: [{ type: "text" as const, text: JSON.stringify(types, null, 2) }] };
    })
  );

  // --- redact_file (task-based: uploads immediately, processes in background) ---
  s.experimental.tasks.registerToolTask(
    "redact_file",
    {
      description: `Redact PII from a single binary file (PDF, docx, xlsx, images). Uploads the file to Textual and processes in the background — does NOT block while waiting.

Do NOT use this for text-based files (.txt, .json, .xml, .html, .htm, .csv, .tsv). Use redact_text, redact_json, redact_xml, or redact_html instead — they are faster and return inline results.

IMPORTANT: If you need to redact multiple files or an entire directory, use deidentify_folder instead — do NOT call this tool in a loop or write a script to iterate over files.

Supported formats: PDF, docx, xlsx, PNG, JPG, JPEG, TIF/TIFF.`,
      inputSchema: {
        filePath: z.string().describe("Absolute path to the file to redact"),
        outputPath: z.string().describe("Absolute path where the redacted file should be saved"),
        ...redactOptionSchemas,
      },
      execution: { taskSupport: "optional" as const },
    },
    {
      createTask: async (params, extra) => {
        logger.logToolCall("redact_file", params as Record<string, unknown>);
        if (!fs.existsSync(params.filePath)) {
          throw new Error(`File not found: ${params.filePath}`);
        }
        const ext = path.extname(params.filePath).toLowerCase();
        const textTypes = [".txt", ".json", ".html", ".htm", ".xml", ".csv", ".tsv"];
        if (textTypes.includes(ext)) {
          throw new Error(`${ext} files should be redacted using the text-based redaction tools (redact_text, redact_json, redact_xml, redact_html) which are faster and return inline results.`);
        }

        const job = await client.startFileRedaction(params.filePath);
        const opts = buildRedactOpts(params);
        const task = await extra.taskStore.createTask({ ttl: (POLL_TIMEOUT_S + 60) * 1000, pollInterval: POLL_INTERVAL_MS });
        logger.info("redact_file_task_created", { taskId: task.taskId, jobId: job.jobId, file: params.filePath });

        // Background: poll for completion, download, save
        (async () => {
          try {
            const buffer = await pollAndDownload(job.jobId, opts);
            const dir = path.dirname(params.outputPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(params.outputPath, buffer);
            logger.info("redact_file_task_complete", { taskId: task.taskId, outputPath: params.outputPath, bytes: buffer.length });
            await extra.taskStore.storeTaskResult(task.taskId, "completed", {
              content: [{ type: "text" as const, text: `Redacted file saved to: ${params.outputPath} (${buffer.length} bytes)` }],
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("redact_file_task_error", { taskId: task.taskId, error: msg });
            try {
              await extra.taskStore.storeTaskResult(task.taskId, "failed", {
                content: [{ type: "text" as const, text: `Error redacting file: ${msg}` }],
                isError: true,
              });
            } catch (storeErr) {
              logger.error("redact_file_task_store_error", {
                taskId: task.taskId,
                originalError: msg,
                storeError: storeErr instanceof Error ? storeErr.message : String(storeErr),
              });
            }
          }
        })();

        return { task };
      },
      getTask: async (_args, extra) => {
        const task = await extra.taskStore.getTask(extra.taskId);
        if (!task) throw new Error(`Task not found: ${extra.taskId}`);
        return task;
      },
      getTaskResult: async (_args, extra) => {
        const result = await extra.taskStore.getTaskResult(extra.taskId);
        return result as { content: Array<{ type: "text"; text: string }> };
      },
    }
  );

  // --- list_file_jobs ---
  s.tool(
    "list_file_jobs",
    "List all unattached file redaction jobs and their statuses. Optionally filter to jobs from a recent time window (e.g. '1h', '30m', '7d').",
    { from: z.string().optional().describe("Time window to look back, e.g. '1h', '30m', '7d'. Converted to TimeSpan format automatically. If omitted, returns all jobs.") },
    withLogging(logger, "list_file_jobs", async ({ from }) => {
      const jobs = await client.listFileJobs(from ? toTimeSpan(from) : undefined);
      return { content: [{ type: "text" as const, text: JSON.stringify(jobs, null, 2) }] };
    })
  );

  // --- get_file_job ---
  s.tool(
    "get_file_job",
    "Get the status and details of a specific unattached file redaction job.",
    { jobId: z.string().describe("The job ID to check") },
    withLogging(logger, "get_file_job", async ({ jobId }) => {
      const job = await client.getFileJob(jobId);
      return { content: [{ type: "text" as const, text: JSON.stringify(job, null, 2) }] };
    })
  );

  // --- download_redacted_file ---
  s.tool(
    "download_redacted_file",
    "Download the redacted version of an unattached file job that has already been uploaded and processed. Use get_file_job or list_file_jobs to find the job ID. Only works for jobs with Completed status.",
    {
      jobId: z.string().describe("The job ID of a completed file redaction job"),
      outputPath: z.string().describe("Absolute path where the redacted file should be saved"),
      ...redactOptionSchemas,
    },
    withLogging(logger, "download_redacted_file", async (params, extra) => {
      const signal: AbortSignal | undefined = extra?.signal;
      const opts = buildRedactOpts(params);
      const buffer = await client.downloadRedactedFile(params.jobId, opts, signal);
      const dir = path.dirname(params.outputPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(params.outputPath, buffer);
      return { content: [{ type: "text" as const, text: `Redacted file saved to: ${params.outputPath} (${buffer.length} bytes)` }] };
    })
  );

  // --- get_job_error_logs ---
  s.tool(
    "get_job_error_logs",
    "Download error logs for a failed file redaction job. Only available for jobs with a failed status.",
    { jobId: z.string().describe("The job ID to get error logs for") },
    withLogging(logger, "get_job_error_logs", async ({ jobId }) => {
      const logs = await client.getJobErrorLogs(jobId);
      return { content: [{ type: "text" as const, text: logs || "No error logs available for this job." }] };
    })
  );

  // --- create_dataset ---
  s.tool(
    "create_dataset",
    "Create a new Tonic Textual dataset. Datasets are collections of files that can be scanned and redacted together with shared configuration.",
    { name: z.string().describe("Name for the new dataset") },
    withLogging(logger, "create_dataset", async ({ name }) => {
      const dataset = await client.createDataset(name);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ datasetId: dataset.id, name: dataset.name, message: "Dataset created. Use upload_file_to_dataset to add files." }, null, 2),
        }],
      };
    })
  );

  // --- list_datasets ---
  s.tool(
    "list_datasets",
    "List all Tonic Textual datasets accessible to the current user.",
    {},
    withLogging(logger, "list_datasets", async () => {
      const datasets = await client.listDatasets();
      const summary = datasets.map((d: Dataset) => ({ id: d.id, name: d.name, fileCount: d.files?.length ?? 0 }));
      return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
    })
  );

  // --- get_dataset ---
  s.tool(
    "get_dataset",
    "Get details about a specific Tonic Textual dataset, including its files and their processing status.",
    { datasetId: z.string().describe("The dataset ID") },
    withLogging(logger, "get_dataset", async ({ datasetId }) => {
      const dataset = await client.getDataset(datasetId);
      return { content: [{ type: "text" as const, text: JSON.stringify(dataset, null, 2) }] };
    })
  );

  // --- upload_file_to_dataset ---
  s.tool(
    "upload_file_to_dataset",
    "Upload a file to an existing Tonic Textual dataset for scanning and redaction.",
    { datasetId: z.string().describe("The dataset ID to upload to"), filePath: z.string().describe("Absolute path to the file to upload") },
    withLogging(logger, "upload_file_to_dataset", async ({ datasetId, filePath }) => {
      if (!fs.existsSync(filePath)) {
        return { content: [{ type: "text" as const, text: `Error: File not found: ${filePath}` }], isError: true };
      }
      const upload = await client.uploadFileToDataset(datasetId, filePath);
      const file = upload.uploadedFile;
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            fileId: upload.uploadedFileId ?? file?.fileId ?? null,
            fileName: file?.fileName ?? path.basename(filePath),
            status: file?.processingStatus ?? null,
            message: "File uploaded to dataset. Textual will scan it for PII.",
          }, null, 2),
        }],
      };
    })
  );

  // --- download_dataset_file ---
  s.tool(
    "download_dataset_file",
    "Download a redacted version of a specific file from a dataset.",
    { datasetId: z.string().describe("The dataset ID"), fileId: z.string().describe("The file ID within the dataset"), outputPath: z.string().describe("Absolute path where the redacted file should be saved") },
    withLogging(logger, "download_dataset_file", async ({ datasetId, fileId, outputPath }) => {
      const buffer = await client.downloadDatasetFile(datasetId, fileId);
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(outputPath, buffer);
      return { content: [{ type: "text" as const, text: `Redacted file saved to: ${outputPath} (${buffer.length} bytes)` }] };
    })
  );

  // --- create_model_based_entity ---
  s.tool(
    "create_model_based_entity",
    "Create a new model-based entity with initial guidelines. Returns the entity ID and current lifecycle status.",
    {
      name: modelBasedEntityNameSchema,
      guidelines: modelBasedEntityGuidelinesSchema,
    },
    withLogging(logger, "create_model_based_entity", async ({ name, guidelines }) => {
      const entity = await client.createModelBasedEntity(name, guidelines);
      return jsonTextResult({
        ...summarizeModelBasedEntity(entity),
        message: "Model-based entity created.",
      });
    })
  );

  // --- list_model_based_entities ---
  s.tool(
    "list_model_based_entities",
    "List active model-based entities and their current lifecycle status.",
    {},
    withLogging(logger, "list_model_based_entities", async () => {
      const entities = await client.listModelBasedEntities();
      return jsonTextResult({
        count: entities.length,
        entities: entities.map((entity) => summarizeModelBasedEntity(entity)),
      });
    })
  );

  // --- list_all_model_based_entities ---
  s.tool(
    "list_all_model_based_entities",
    "List all accessible model-based custom entities from the paginated custom-entities endpoint. Supports optional search, user/status filters, and server-side sorting while always constraining entityType to ModelBased.",
    {
      offset: paginationOffsetSchema,
      limit: paginationLimitSchema,
      search: customEntitySearchSchema,
      users: customEntityUsersSchema,
      statuses: modelBasedEntityStatusesSchema,
      sortBy: customEntitySortBySchema,
      sortDirection: customEntitySortDirectionSchema,
    },
    withLogging(
      logger,
      "list_all_model_based_entities",
      async ({ offset, limit, search, users, statuses, sortBy, sortDirection }) => {
        const result = await client.listAllModelBasedEntities({
          offset,
          limit,
          search,
          users,
          statuses,
          sortBy,
          sortDirection,
        });

        return jsonTextResult({
          count: result.records.length,
          totalRecords: result.totalRecords,
          ...(typeof result.offset === "number" ? { offset: result.offset } : {}),
          ...(typeof result.limit === "number" ? { limit: result.limit } : {}),
          ...(typeof result.pageNumber === "number" ? { pageNumber: result.pageNumber } : {}),
          ...(typeof result.totalPages === "number" ? { totalPages: result.totalPages } : {}),
          ...(typeof result.absoluteTotalRecords === "number"
            ? { absoluteTotalRecords: result.absoluteTotalRecords }
            : {}),
          ...(typeof result.hasPreviousPage === "boolean" ? { hasPreviousPage: result.hasPreviousPage } : {}),
          ...(typeof result.hasNextPage === "boolean" ? { hasNextPage: result.hasNextPage } : {}),
          ...(typeof result.search === "string" ? { search: result.search } : {}),
          ...(Array.isArray(result.users) && result.users.length > 0 ? { users: result.users } : {}),
          ...(Array.isArray(result.statuses) && result.statuses.length > 0 ? { statuses: result.statuses } : {}),
          ...(typeof result.sortBy === "string" ? { sortBy: result.sortBy } : {}),
          ...(typeof result.sortDirection === "string" ? { sortDirection: result.sortDirection } : {}),
          records: result.records.map((entity) => summarizeModelBasedEntity(entity)),
        });
      }
    )
  );

  // --- get_model_based_entity ---
  s.tool(
    "get_model_based_entity",
    "Get details for a specific model-based entity, including lifecycle status, file source, and current activation state.",
    {
      entityId: modelBasedEntityIdSchema,
    },
    withLogging(logger, "get_model_based_entity", async ({ entityId }) => {
      const entity = await client.getModelBasedEntity(entityId);
      return jsonTextResult(summarizeModelBasedEntityDetails(entity));
    })
  );

  // --- update_model_based_entity ---
  s.tool(
    "update_model_based_entity",
    "Update a model-based entity by sending a JSON object of fields accepted by Textual's entity update endpoint. Returns the updated entity state.",
    {
      entityId: modelBasedEntityIdSchema,
      updates: z
        .record(z.string(), z.unknown())
        .describe("JSON object of fields to update, such as entity metadata or file-source configuration"),
    },
    withLogging(logger, "update_model_based_entity", async ({ entityId, updates }) => {
      const entity = await client.updateModelBasedEntity(entityId, updates as Record<string, unknown>);
      return jsonTextResult({
        ...summarizeModelBasedEntityDetails(entity),
        message: "Model-based entity updated.",
      });
    })
  );

  // --- delete_model_based_entity ---
  s.tool(
    "delete_model_based_entity",
    "Delete a model-based entity. This returns an immediate status payload and does not wait for any downstream cleanup beyond the initial API response.",
    {
      entityId: modelBasedEntityIdSchema,
    },
    withLogging(logger, "delete_model_based_entity", async ({ entityId }) => {
      const result = await client.deleteModelBasedEntity(entityId);
      return jsonTextResult(
        summarizeAsyncEntityAction(
          "entity_delete_requested",
          entityId,
          result,
          "Model-based entity delete request submitted."
        )
      );
    })
  );

  // --- create_entity_version ---
  s.tool(
    "create_entity_version",
    "Create a new version for an existing model-based entity using updated guidelines. Follow-up analysis may continue asynchronously; this returns immediately with the new version ID and current status.",
    {
      entityId: modelBasedEntityIdSchema,
      guidelines: modelBasedEntityGuidelinesSchema,
    },
    withLogging(logger, "create_entity_version", async ({ entityId, guidelines }) => {
      const version = await client.createEntityVersion(entityId, guidelines);
      return jsonTextResult({
        ...summarizeEntityVersion(version, { includeGuidelines: true }),
        message: "Entity version created.",
      });
    })
  );

  // --- get_suggested_guidelines ---
  s.tool(
    "get_suggested_guidelines",
    "Get suggested guideline refinements for a specific entity version after Textual has generated them.",
    {
      entityId: modelBasedEntityIdSchema,
      versionId: modelBasedEntityVersionIdSchema,
    },
    withLogging(logger, "get_suggested_guidelines", async ({ entityId, versionId }) => {
      const result = await client.getSuggestedGuidelines(entityId, versionId);
      return jsonTextResult({ entityId, versionId, guidelines: result.guidelines });
    })
  );

  // --- list_entity_versions ---
  s.tool(
    "list_entity_versions",
    "List the versions for a model-based entity, including status and evaluation metrics for each version.",
    {
      entityId: modelBasedEntityIdSchema,
    },
    withLogging(logger, "list_entity_versions", async ({ entityId }) => {
      const versions = await client.listEntityVersions(entityId);
      return jsonTextResult({
        entityId,
        count: versions.length,
        versions: versions.map((version) => summarizeEntityVersion(version)),
      });
    })
  );

  // --- retry_version_annotation ---
  s.tool(
    "retry_version_annotation",
    "Retry annotation for a model-based entity version that needs another annotation pass. This returns immediately with the current accepted status payload.",
    {
      entityId: modelBasedEntityIdSchema,
      versionId: modelBasedEntityVersionIdSchema,
    },
    withLogging(logger, "retry_version_annotation", async ({ entityId, versionId }) => {
      const result = await client.retryVersionAnnotation(entityId, versionId);
      return jsonTextResult(
        summarizeAsyncVersionAction(
          "version_annotation_retry_requested",
          entityId,
          versionId,
          result,
          "Version annotation retry requested."
        )
      );
    })
  );

  // --- retry_suggested_guidelines ---
  s.tool(
    "retry_suggested_guidelines",
    "Retry suggested-guideline generation for a model-based entity version. This returns immediately with the current accepted status payload.",
    {
      entityId: modelBasedEntityIdSchema,
      versionId: modelBasedEntityVersionIdSchema,
    },
    withLogging(logger, "retry_suggested_guidelines", async ({ entityId, versionId }) => {
      const result = await client.retrySuggestedGuidelines(entityId, versionId);
      return jsonTextResult(
        summarizeAsyncVersionAction(
          "suggested_guidelines_retry_requested",
          entityId,
          versionId,
          result,
          "Suggested-guidelines retry requested."
        )
      );
    })
  );

  // --- get_supported_entity_file_types ---
  s.tool(
    "get_supported_entity_file_types",
    "List the MIME types supported for model-based entity test/training file ingestion.",
    {},
    withLogging(logger, "get_supported_entity_file_types", async () => {
      const supportedFileTypes = await client.getSupportedEntityFileTypes();
      return jsonTextResult({
        count: supportedFileTypes.length,
        supportedFileTypes,
      });
    })
  );

  // --- create_trained_model ---
  s.tool(
    "create_trained_model",
    "Create a trained-model record for an entity version. Returns the model ID and current readiness status for follow-up training calls.",
    {
      entityId: modelBasedEntityIdSchema,
      versionId: modelBasedEntityVersionIdSchema,
    },
    withLogging(logger, "create_trained_model", async ({ entityId, versionId }) => {
      const model = await client.createTrainedModel(entityId, versionId);
      return jsonTextResult({
        ...summarizeTrainedModel(model),
        message: "Trained model record created.",
      });
    })
  );

  // --- list_trained_models ---
  s.tool(
    "list_trained_models",
    "List all trained models for a model-based entity, including readiness, progress, activation state, and benchmark summary fields.",
    {
      entityId: modelBasedEntityIdSchema,
    },
    withLogging(logger, "list_trained_models", async ({ entityId }) => {
      const models = await client.listTrainedModels(entityId);
      return jsonTextResult({
        entityId,
        count: models.length,
        models: models.map((model) => summarizeTrainedModel(model)),
      });
    })
  );

  // --- get_trained_model ---
  s.tool(
    "get_trained_model",
    "Get the current status of a trained model for a model-based entity.",
    {
      entityId: modelBasedEntityIdSchema,
      modelId: trainedModelIdSchema,
    },
    withLogging(logger, "get_trained_model", async ({ entityId, modelId }) => {
      const model = await client.getTrainedModel(entityId, modelId);
      return jsonTextResult(summarizeTrainedModel(model));
    })
  );

  // --- list_model_training_files ---
  s.tool(
    "list_model_training_files",
    "List the training files attached to a specific trained model. Supports optional server-side search and pagination and returns normalized pagination metadata for MCP consumers.",
    {
      entityId: modelBasedEntityIdSchema,
      modelId: trainedModelIdSchema,
      search: entityFileSearchSchema,
      offset: paginationOffsetSchema,
      limit: paginationLimitSchema,
    },
    withLogging(logger, "list_model_training_files", async ({ entityId, modelId, search, offset, limit }) => {
      const result = await client.listModelTrainingFiles(entityId, modelId, { search, offset, limit });
      return jsonTextResult({
        entityId,
        modelId,
        count: result.files.length,
        totalCount: result.totalCount,
        ...(typeof result.absoluteTotalCount === "number" ? { absoluteTotalCount: result.absoluteTotalCount } : {}),
        ...(typeof result.totalPages === "number" ? { totalPages: result.totalPages } : {}),
        ...(typeof result.search === "string" ? { search: result.search } : {}),
        ...(typeof result.offset === "number" ? { offset: result.offset } : {}),
        ...(typeof result.limit === "number" ? { limit: result.limit } : {}),
        files: result.files.map((file) => summarizeModelTrainingFile(file)),
      });
    })
  );

  // --- get_model_training_file ---
  s.tool(
    "get_model_training_file",
    "Get details for a specific trained-model training file, including the annotated content and spans when available.",
    {
      entityId: modelBasedEntityIdSchema,
      modelId: trainedModelIdSchema,
      fileId: modelBasedEntityFileIdSchema,
    },
    withLogging(logger, "get_model_training_file", async ({ entityId, modelId, fileId }) => {
      const file = await client.getModelTrainingFile(entityId, modelId, fileId);
      return jsonTextResult({
        entityId,
        modelId,
        ...summarizeModelTrainingFileDetails(file),
      });
    })
  );

  // --- list_model_detected_entities ---
  s.tool(
    "list_model_detected_entities",
    "List the most common detected entity values for a trained model. Supports optional server-side search and pagination and returns normalized pagination metadata for MCP consumers.",
    {
      entityId: modelBasedEntityIdSchema,
      modelId: trainedModelIdSchema,
      search: modelDetectedEntitySearchSchema,
      offset: paginationOffsetSchema,
      limit: paginationLimitSchema,
    },
    withLogging(logger, "list_model_detected_entities", async ({ entityId, modelId, search, offset, limit }) => {
      const result = await client.listModelDetectedEntities(entityId, modelId, { search, offset, limit });
      return jsonTextResult({
        entityId,
        modelId,
        count: result.entities.length,
        totalCount: result.totalCount,
        ...(typeof result.search === "string" ? { search: result.search } : {}),
        ...(typeof result.offset === "number" ? { offset: result.offset } : {}),
        ...(typeof result.limit === "number" ? { limit: result.limit } : {}),
        entities: result.entities.map((entity) => summarizeModelDetectedEntity(entity)),
      });
    })
  );

  // --- start_model_training ---
  s.tool(
    "start_model_training",
    "Start training a trained model. This begins an asynchronous operation and returns immediately with the current status; it does not wait for training to finish.",
    {
      entityId: modelBasedEntityIdSchema,
      modelId: trainedModelIdSchema,
    },
    withLogging(logger, "start_model_training", async ({ entityId, modelId }) => {
      const result = await client.startModelTraining(entityId, modelId);
      return jsonTextResult(summarizeAsyncModelAction("training_started", entityId, modelId, result));
    })
  );

  // --- activate_trained_model ---
  s.tool(
    "activate_trained_model",
    "Activate a trained model for an entity. This request returns immediately and does not wait for activation propagation to complete.",
    {
      entityId: modelBasedEntityIdSchema,
      modelId: trainedModelIdSchema,
    },
    withLogging(logger, "activate_trained_model", async ({ entityId, modelId }) => {
      const result = await client.activateTrainedModel(entityId, modelId);
      return jsonTextResult(summarizeAsyncModelAction("activation_requested", entityId, modelId, result));
    })
  );

  // --- get_entity_version ---
  s.tool(
    "get_entity_version",
    "Get details for a specific entity version, including status, guidelines, metrics, and per-file summaries.",
    {
      entityId: modelBasedEntityIdSchema,
      versionId: modelBasedEntityVersionIdSchema,
    },
    withLogging(logger, "get_entity_version", async ({ entityId, versionId }) => {
      const version = await client.getEntityVersion(entityId, versionId);
      return jsonTextResult(summarizeEntityVersion(version, { includeGuidelines: true, includeFiles: true }));
    })
  );

  // --- upload_entity_test_file ---
  s.tool(
    "upload_entity_test_file",
    "Upload a local test/review file for a model-based entity. The file must already exist on disk; Textual analyzes it asynchronously for version review workflows.",
    {
      entityId: modelBasedEntityIdSchema,
      filePath: z.string().describe("Absolute path to the local file to upload"),
    },
    withLogging(logger, "upload_entity_test_file", async ({ entityId, filePath }) => {
      if (!fs.existsSync(filePath)) {
        return { content: [{ type: "text" as const, text: `Error: File not found: ${filePath}` }], isError: true };
      }

      const file = await client.uploadEntityTestFile(entityId, filePath);
      return jsonTextResult({
        ...summarizeEntityTestFile(entityId, file),
        message: "Entity test file uploaded.",
      });
    })
  );

  // --- list_entity_test_files ---
  s.tool(
    "list_entity_test_files",
    "List the test/review files attached to a model-based entity, including their annotation/review status and minimum eligible version.",
    {
      entityId: modelBasedEntityIdSchema,
    },
    withLogging(logger, "list_entity_test_files", async ({ entityId }) => {
      const files = await client.listEntityTestFiles(entityId);
      return jsonTextResult({
        entityId,
        count: files.length,
        files: files.map((file) => summarizeEntityTestFile(entityId, file)),
      });
    })
  );

  // --- delete_entity_test_file ---
  s.tool(
    "delete_entity_test_file",
    "Delete a model-based entity test/review file so it is excluded from future review workflows. Returns the immediate API response without waiting for any downstream processing.",
    {
      entityId: modelBasedEntityIdSchema,
      fileId: modelBasedEntityFileIdSchema,
    },
    withLogging(logger, "delete_entity_test_file", async ({ entityId, fileId }) => {
      const result = await client.deleteEntityTestFile(entityId, fileId);
      return jsonTextResult(summarizeEntityTestFileDeletion(entityId, fileId, result));
    })
  );

  // --- save_entity_ground_truth ---
  s.tool(
    "save_entity_ground_truth",
    "Save reviewed ground-truth annotation spans for a model-based entity test file. Spans use start/end character offsets into the file content and can optionally mark the file as reviewed.",
    {
      entityId: modelBasedEntityIdSchema,
      fileId: modelBasedEntityFileIdSchema,
      annotations: z.array(modelBasedEntityAnnotationSpanSchema).describe("Ground-truth annotation spans for the file"),
      markAsReviewed: z.boolean().describe("Whether to mark the file review as complete after saving the annotations"),
    },
    withLogging(logger, "save_entity_ground_truth", async ({ entityId, fileId, annotations, markAsReviewed }) => {
      const file = await client.saveEntityGroundTruth(
        entityId,
        fileId,
        annotations as ModelBasedEntityAnnotationSpan[],
        markAsReviewed
      );
      return jsonTextResult(summarizeSavedGroundTruth(entityId, fileId, file));
    })
  );

  // --- upload_entity_training_file ---
  s.tool(
    "upload_entity_training_file",
    "Upload a local training file for a model-based entity. The file must already exist on disk; Textual analyzes it asynchronously before it can be used for model training.",
    {
      entityId: modelBasedEntityIdSchema,
      filePath: z.string().describe("Absolute path to the local file to upload"),
    },
    withLogging(logger, "upload_entity_training_file", async ({ entityId, filePath }) => {
      if (!fs.existsSync(filePath)) {
        return { content: [{ type: "text" as const, text: `Error: File not found: ${filePath}` }], isError: true };
      }

      const file = await client.uploadEntityTrainingFile(entityId, filePath);
      return jsonTextResult({
        ...summarizeEntityTrainingFile(file),
        message: "Entity training file uploaded.",
      });
    })
  );

  // --- list_entity_training_files ---
  s.tool(
    "list_entity_training_files",
    "List the training files for a model-based entity. Supports optional server-side search and pagination, and returns normalized pagination metadata for MCP consumers.",
    {
      entityId: modelBasedEntityIdSchema,
      search: entityFileSearchSchema,
      offset: paginationOffsetSchema,
      limit: paginationLimitSchema,
    },
    withLogging(logger, "list_entity_training_files", async ({ entityId, search, offset, limit }) => {
      const result = await client.listEntityTrainingFiles(entityId, { search, offset, limit });
      return jsonTextResult({
        entityId,
        count: result.files.length,
        totalCount: result.totalCount,
        ...(typeof result.search === "string" ? { search: result.search } : {}),
        ...(typeof result.offset === "number" ? { offset: result.offset } : {}),
        ...(typeof result.limit === "number" ? { limit: result.limit } : {}),
        files: result.files.map((file) => summarizeEntityTrainingFile(file)),
      });
    })
  );

  // --- get_entity_training_file ---
  s.tool(
    "get_entity_training_file",
    "Get details for a specific model-based entity training file, including the stored content when available.",
    {
      entityId: modelBasedEntityIdSchema,
      fileId: modelBasedEntityFileIdSchema,
    },
    withLogging(logger, "get_entity_training_file", async ({ entityId, fileId }) => {
      const file = await client.getEntityTrainingFile(entityId, fileId);
      return jsonTextResult(summarizeEntityTrainingFileDetails(file));
    })
  );

  // --- delete_entity_training_file ---
  s.tool(
    "delete_entity_training_file",
    "Delete a model-based entity training file so it is excluded from future model creation/training runs. Returns the immediate API response without waiting for downstream processing.",
    {
      entityId: modelBasedEntityIdSchema,
      fileId: modelBasedEntityFileIdSchema,
    },
    withLogging(logger, "delete_entity_training_file", async ({ entityId, fileId }) => {
      const result = await client.deleteEntityTrainingFile(entityId, fileId);
      return jsonTextResult(summarizeEntityTrainingFileDeletion(entityId, fileId, result));
    })
  );

  // --- get_entity_file_annotations ---
  s.tool(
    "get_entity_file_annotations",
    "Get annotation details for a specific entity-version file, including content, annotation spans, metrics, and review status. If versionId is omitted, the latest available entity version is used.",
    {
      entityId: modelBasedEntityIdSchema,
      versionId: modelBasedEntityVersionIdSchema.optional().describe("Optional entity version ID. If omitted, the latest available entity version is used."),
      fileId: modelBasedEntityFileIdSchema,
      forcePredictions: z.boolean().optional().describe("If true, force regeneration of predictions before returning file annotations"),
    },
    withLogging(logger, "get_entity_file_annotations", async ({ entityId, versionId, fileId, forcePredictions }) => {
      const resolvedVersionId = versionId ?? await resolveLatestEntityVersionId(entityId);
      const file = await client.getEntityFileAnnotations(entityId, resolvedVersionId, fileId, forcePredictions);
      return jsonTextResult({
        entityId,
        ...summarizeEntityFileAnnotations(file),
      });
    })
  );

  // --- activate_entity_for_dataset ---
  s.tool(
    "activate_entity_for_dataset",
    "Activate the current active model for a model-based entity on a dataset. This request returns immediately with entity/dataset identifiers and any available activation status.",
    {
      entityId: modelBasedEntityIdSchema,
      datasetId: datasetIdSchema,
    },
    withLogging(logger, "activate_entity_for_dataset", async ({ entityId, datasetId }) => {
      const result = await client.activateEntityForDataset(entityId, datasetId);
      return jsonTextResult(summarizeEntityDatasetActivation(entityId, datasetId, result));
    })
  );

  // --- deactivate_entity_for_dataset ---
  s.tool(
    "deactivate_entity_for_dataset",
    "Deactivate a model-based entity for a dataset. This request returns immediately with entity/dataset identifiers and any available deactivation status.",
    {
      entityId: modelBasedEntityIdSchema,
      datasetId: datasetIdSchema,
    },
    withLogging(logger, "deactivate_entity_for_dataset", async ({ entityId, datasetId }) => {
      const result = await client.deactivateEntityForDataset(entityId, datasetId);
      return jsonTextResult(summarizeEntityDatasetDeactivation(entityId, datasetId, result));
    })
  );

  // --- scan_directory ---
  s.tool(
    "scan_directory",
    "Scan a local directory tree and return an inventory of all files with their types and sizes. Use this to understand the structure before de-identifying.",
    {
      directoryPath: z.string().describe("Absolute path to the directory to scan"),
      maxDepth: z.number().optional().default(10).describe("Maximum directory depth to traverse"),
    },
    withLogging(logger, "scan_directory", async ({ directoryPath, maxDepth }) => {
      if (!fs.existsSync(directoryPath)) {
        return { content: [{ type: "text" as const, text: `Error: Directory not found: ${directoryPath}` }], isError: true };
      }

      interface FileEntry { relativePath: string; size: number; type: string; isDirectory: boolean; }
      const entries: FileEntry[] = [];

      function walk(dir: string, depth: number) {
        if (depth > maxDepth) return;
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          const fullPath = path.join(dir, item.name);
          const relativePath = path.relative(directoryPath, fullPath);
          if (item.isDirectory()) {
            entries.push({ relativePath: relativePath + "/", size: 0, type: "directory", isDirectory: true });
            walk(fullPath, depth + 1);
          } else {
            const stat = fs.statSync(fullPath);
            entries.push({ relativePath, size: stat.size, type: lookup(fullPath) || "unknown", isDirectory: false });
          }
        }
      }

      walk(directoryPath, 0);
      const files = entries.filter((e) => !e.isDirectory);
      const dirs = entries.filter((e) => e.isDirectory);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            rootPath: directoryPath,
            totalFiles: files.length,
            totalDirectories: dirs.length,
            totalSizeBytes: files.reduce((s, f) => s + f.size, 0),
            directories: dirs.map((d) => d.relativePath),
            files: files.map((f) => ({ path: f.relativePath, size: f.size, type: f.type })),
          }, null, 2),
        }],
      };
    })
  );

  // --- deidentify_folder ---
  s.tool(
    "deidentify_folder",
    `De-identify an entire folder tree in a single call. This is the PREFERRED tool whenever the user wants to redact, de-identify, or anonymize multiple files or a directory. Do NOT loop over files calling redact_text/redact_file individually, and do NOT write scripts to batch-process files — use this tool instead.

This tool handles everything:
1. Walks the source directory tree
2. Automatically picks the right redaction method per file type (text, JSON, HTML, XML, PDF, docx, images, etc.)
3. Supports JSON-specific options (jsonPathIgnorePaths, jsonPathAllowLists) — any options you tested with redact_json work here too
4. Processes files in parallel for speed
5. Set deidentifyNames=true to redact PII in folder and file names (e.g. "Dad_15084238708" → "Uncle_96771033448")
6. Writes everything to the output directory preserving folder structure

Recommended workflow: use scan_directory to preview, test redact_text/redact_json on ONE sample file to tune options, then call THIS tool with those same options to process the full folder. After testing a sample, your next step should ALWAYS be deidentify_folder — not a script.`,
    {
      sourcePath: z.string().describe("Absolute path to the source directory"),
      outputPath: z.string().describe("Absolute path to the output directory (will be created)"),
      deidentifyNames: z.boolean().optional().default(false).describe("If true, also de-identify folder and file names by running them through Textual text redaction"),
      ...redactOptionSchemas,
      jsonPathAllowLists: z
        .record(z.string(), z.array(z.string()))
        .optional()
        .describe(
          "For JSON files only: map of entity type labels to arrays of JSONPath expressions. Values at these paths are force-detected as the given entity type."
        ),
      jsonPathIgnorePaths: z
        .array(z.string())
        .optional()
        .describe(
          "For JSON files only: array of JSONPath expressions for values that should NOT be redacted. Example: [\"$[*].id\", \"$[*].timestamp\"]"
        ),
      fileExtensions: z.array(z.string()).optional().describe("If provided, only process files with these extensions (e.g. ['.pdf', '.docx', '.txt']). Others are skipped."),
      skipPatterns: z.array(z.string()).optional().describe("Glob-like patterns of files/folders to skip (e.g. ['node_modules', '.git', '*.log'])"),
    },
    withLogging(logger, "deidentify_folder", async ({
      sourcePath, outputPath, deidentifyNames,
      generatorConfig, generatorDefault, generatorMetadata, customEntities, labelBlockLists, labelAllowLists,
      jsonPathAllowLists, jsonPathIgnorePaths,
      fileExtensions, skipPatterns,
    }, extra) => {
      const signal: AbortSignal | undefined = extra?.signal;
      if (!fs.existsSync(sourcePath)) {
        return { content: [{ type: "text" as const, text: `Error: Source directory not found: ${sourcePath}` }], isError: true };
      }

      const opts = buildRedactOpts({ generatorConfig, generatorDefault, generatorMetadata, customEntities, labelBlockLists, labelAllowLists });
      const jsonOpts: JsonRedactOptions = { ...opts, jsonPathAllowLists, jsonPathIgnorePaths };
      const results: Array<{ source: string; output: string; status: "success" | "skipped" | "error"; error?: string }> = [];
      const nameCache = new Map<string, string>();

      async function deidentifyName(name: string): Promise<string> {
        if (!deidentifyNames) return name;
        if (nameCache.has(name)) return nameCache.get(name)!;
        const ext = path.extname(name);
        const baseName = ext ? name.slice(0, -ext.length) : name;
        try {
          logger.info("name_redact_start", { tool: "deidentify_folder", name });
          const result = await client.redactText(baseName, { ...opts, generatorDefault: opts.generatorDefault || "Synthesis" }, signal);
          const newBase = result.deIdentifyResults && result.deIdentifyResults.length > 0 ? result.redactedText : baseName;
          const newName = ext ? newBase + ext : newBase;
          nameCache.set(name, newName);
          logger.info("name_redact_complete", { tool: "deidentify_folder", original: name, redacted: newName });
          return newName;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error("name_redact_error", { tool: "deidentify_folder", name, error: msg });
          nameCache.set(name, name);
          return name;
        }
      }

      function shouldSkip(relativePath: string): boolean {
        if (!skipPatterns || skipPatterns.length === 0) return false;
        return skipPatterns.some((pattern) => {
          if (relativePath.includes(pattern)) return true;
          const name = path.basename(relativePath);
          if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1));
          return name === pattern;
        });
      }

      function matchesExtensions(filePath: string): boolean {
        if (!fileExtensions || fileExtensions.length === 0) return true;
        const ext = path.extname(filePath).toLowerCase();
        return fileExtensions.map((e) => e.toLowerCase()).includes(ext);
      }

      const textTypes = [".txt", ".json", ".html", ".htm", ".xml"];
      const fileTypes = [".pdf", ".docx", ".xlsx", ".png", ".jpg", ".jpeg", ".csv", ".tsv"];

      interface WorkItem { srcFull: string; outFilePath: string; relPath: string; ext: string; }
      const textItems: WorkItem[] = [];
      const binaryItems: WorkItem[] = [];

      // Phase 1: Walk tree, create output directories, collect work items
      async function collectWork(srcDir: string, outDir: string) {
        signal?.throwIfAborted();
        const items = fs.readdirSync(srcDir, { withFileTypes: true });
        for (const item of items) {
          signal?.throwIfAborted();
          const srcFull = path.join(srcDir, item.name);
          const relPath = path.relative(sourcePath, srcFull);
          if (shouldSkip(relPath)) {
            logger.info("file_skipped", { tool: "deidentify_folder", file: relPath, reason: "Matched skip pattern" });
            results.push({ source: relPath, output: "", status: "skipped", error: "Matched skip pattern" });
            continue;
          }
          const outName = await deidentifyName(item.name);
          if (item.isDirectory()) {
            logger.info("directory_enter", { tool: "deidentify_folder", directory: relPath });
            const outSubDir = path.join(outDir, outName);
            fs.mkdirSync(outSubDir, { recursive: true });
            await collectWork(srcFull, outSubDir);
          } else {
            if (!matchesExtensions(item.name)) {
              logger.info("file_skipped", { tool: "deidentify_folder", file: relPath, reason: "Extension not in filter list" });
              results.push({ source: relPath, output: "", status: "skipped", error: "Extension not in filter list" });
              continue;
            }
            const ext = path.extname(item.name).toLowerCase();
            const outFilePath = path.join(outDir, outName);
            if (textTypes.includes(ext)) {
              textItems.push({ srcFull, outFilePath, relPath, ext });
            } else if (fileTypes.includes(ext)) {
              binaryItems.push({ srcFull, outFilePath, relPath, ext });
            } else {
              logger.info("file_skipped", { tool: "deidentify_folder", file: relPath, reason: "Unsupported file type" });
              results.push({ source: relPath, output: "", status: "skipped", error: "Unsupported file type" });
            }
          }
        }
      }

      fs.mkdirSync(outputPath, { recursive: true });
      await collectWork(sourcePath, outputPath);

      logger.info("work_collected", { tool: "deidentify_folder", textFiles: textItems.length, binaryFiles: binaryItems.length, skipped: results.length });

      // Phase 2: Process text files in parallel
      async function processTextItem(item: WorkItem) {
        if (signal?.aborted) return;
        const fileStart = Date.now();
        logger.info("file_redact_start", { tool: "deidentify_folder", file: item.relPath, ext: item.ext, mode: "text" });
        try {
          const content = fs.readFileSync(item.srcFull, "utf-8");
          let result: { redactedText: string };
          if (item.ext === ".json") result = await client.redactJson(content, jsonOpts, signal);
          else if (item.ext === ".html" || item.ext === ".htm") result = await client.redactHtml(content, opts, signal);
          else if (item.ext === ".xml") result = await client.redactXml(content, opts, signal);
          else result = await client.redactText(content, opts, signal);
          const redactedBuf = Buffer.from(result.redactedText, "utf-8");
          fs.mkdirSync(path.dirname(item.outFilePath), { recursive: true });
          fs.writeFileSync(item.outFilePath, redactedBuf);
          logger.info("file_redact_complete", { tool: "deidentify_folder", file: item.relPath, outputBytes: redactedBuf.length, durationMs: Date.now() - fileStart });
          results.push({ source: item.relPath, output: path.relative(outputPath, item.outFilePath), status: "success" });
        } catch (err: unknown) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          const msg = err instanceof Error ? err.message : String(err);
          logger.error("file_redact_error", { tool: "deidentify_folder", file: item.relPath, error: msg });
          results.push({ source: item.relPath, output: "", status: "error", error: msg });
        }
      }

      const textPromises = textItems.map((item) => processTextItem(item));

      // Phase 3: Upload binary files serially (fast), collect job IDs
      // Wrapped in async so that if it throws (e.g. abort), we still await textPromises
      async function uploadAndProcessBinaryFiles() {
        const binaryJobs: Array<{ item: WorkItem; jobId: string }> = [];
        for (const item of binaryItems) {
          signal?.throwIfAborted();
          const fileStart = Date.now();
          logger.info("file_redact_start", { tool: "deidentify_folder", file: item.relPath, ext: item.ext, mode: "file_upload" });
          try {
            const job = await client.startFileRedaction(item.srcFull, signal);
            logger.info("file_upload_complete", { tool: "deidentify_folder", file: item.relPath, jobId: job.jobId, durationMs: Date.now() - fileStart });
            binaryJobs.push({ item, jobId: job.jobId });
          } catch (err: unknown) {
            if (err instanceof DOMException && err.name === "AbortError") throw err;
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("file_upload_error", { tool: "deidentify_folder", file: item.relPath, error: msg });
            results.push({ source: item.relPath, output: "", status: "error", error: msg });
          }
        }

        // Phase 4: Poll and download binary files in parallel
        const binaryPromises = binaryJobs.map(({ item, jobId }) => {
          if (signal?.aborted) return Promise.resolve();
          const dlStart = Date.now();
          return pollAndDownload(jobId, opts, signal).then((redactedBuf) => {
            fs.mkdirSync(path.dirname(item.outFilePath), { recursive: true });
            fs.writeFileSync(item.outFilePath, redactedBuf);
            logger.info("file_redact_complete", { tool: "deidentify_folder", file: item.relPath, outputBytes: redactedBuf.length, durationMs: Date.now() - dlStart });
            results.push({ source: item.relPath, output: path.relative(outputPath, item.outFilePath), status: "success" });
          }).catch((err: unknown) => {
            if (err instanceof DOMException && err.name === "AbortError") return;
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("file_redact_error", { tool: "deidentify_folder", file: item.relPath, error: msg });
            results.push({ source: item.relPath, output: "", status: "error", error: msg });
          });
        });
        await Promise.all(binaryPromises);
      }

      // Await all work, using allSettled to ensure no unhandled rejections on abort
      const binaryWork = uploadAndProcessBinaryFiles();
      await Promise.allSettled([...textPromises, binaryWork]);

      const cancelled = signal?.aborted ?? false;
      const successCount = results.filter((r) => r.status === "success").length;
      const errorCount = results.filter((r) => r.status === "error").length;
      const skippedCount = results.filter((r) => r.status === "skipped").length;

      if (cancelled) {
        logger.info("deidentify_folder_cancelled", {
          tool: "deidentify_folder",
          succeeded: successCount,
          totalFiles: textItems.length + binaryItems.length,
        });
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            summary: {
              ...(cancelled ? { cancelled: true } : {}),
              totalFiles: textItems.length + binaryItems.length,
              totalProcessed: results.length,
              succeeded: successCount,
              failed: errorCount,
              skipped: skippedCount,
            },
            outputDirectory: outputPath,
            results,
          }, null, 2),
        }],
      };
    })
  );
}

// ============================================================
// Start the server
// ============================================================
async function main() {
  const port = parseInt(process.env.PORT || "3000", 10);

  // Each session gets its own McpServer + Transport pair so that
  // in-flight request state, abort controllers, and response handlers
  // are fully isolated between sessions.
  let currentSession: {
    server: McpServer;
    transport: StreamableHTTPServerTransport;
  } | null = null;

  function createSession(): { server: McpServer; transport: StreamableHTTPServerTransport } {
    const server = new McpServer({ name: "tonic-textual", version: "1.0.0" }, {
      taskStore: new InMemoryTaskStore(),
    });
    registerTools(server);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    return { server, transport };
  }

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    logger.info("http_request", { method: req.method, path: url.pathname, sessionId: sessionId || null });

    if (url.pathname === "/mcp") {
      try {
        // Route to existing session if session ID matches
        if (sessionId && currentSession?.transport.sessionId === sessionId) {
          await currentSession.transport.handleRequest(req, res);
          return;
        }

        // New initialization: POST without session header
        if (req.method === "POST" && !sessionId) {
          logger.info("new_session", { reason: "POST without session header" });
          if (currentSession) {
            logger.info("closing_previous_session", { previousSessionId: currentSession.transport.sessionId });
            await currentSession.server.close();
          }
          const session = createSession();
          await session.server.connect(session.transport);
          currentSession = session;
          await session.transport.handleRequest(req, res);
          logger.info("session_established", { sessionId: session.transport.sessionId });
          return;
        }

        // Stale session ID on POST — client's session expired, create a new one
        if (req.method === "POST" && sessionId) {
          logger.info("session_expired_reconnect", { expiredSessionId: sessionId });
          if (currentSession) {
            await currentSession.server.close();
          }
          const session = createSession();
          await session.server.connect(session.transport);
          currentSession = session;
          await session.transport.handleRequest(req, res);
          logger.info("session_established", { sessionId: session.transport.sessionId });
          return;
        }

        // GET/DELETE with unknown session — nothing to reconnect to
        logger.info("session_not_found", { method: req.method, sessionId: sessionId || null, currentSessionId: currentSession?.transport.sessionId || null });
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        logger.error("mcp_request_error", { method: req.method, path: url.pathname, error: msg, stack });
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: msg }));
        }
      }
    } else if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } else {
      logger.info("http_not_found", { method: req.method, path: url.pathname });
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });

  httpServer.listen(port, () => {
    logger.info("Tonic Textual MCP server running on HTTP", { port, endpoint: "/mcp" });
  });
}

process.on("uncaughtException", (err) => {
  logger.error("uncaught_exception", { error: String(err), stack: err.stack });
});

process.on("unhandledRejection", (reason) => {
  logger.error("unhandled_rejection", { error: String(reason), stack: reason instanceof Error ? reason.stack : undefined });
});

main().catch((err) => {
  logger.error("Fatal error", { error: String(err) });
  process.exit(1);
});
