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
  type JsonRedactOptions,
  type LabelCustomList,
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
