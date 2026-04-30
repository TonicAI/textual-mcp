import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf-8"));
export const USER_AGENT = `textual-mcp/${packageJson.version} (+https://github.com/TonicAI/textual-mcp)`;

export interface RedactionEntity {
  start: number;
  end: number;
  new_start: number;
  new_end: number;
  label: string;
  text: string;
  new_text: string | null;
  score: number;
  language: string;
  json_path?: string;
  xml_path?: string;
}

export interface RedactionResponse {
  originalText: string;
  redactedText: string;
  usage: number;
  deIdentifyResults: RedactionEntity[];
}

export interface BulkRedactionResponse {
  bulkRedactionResults: RedactionResponse[];
}

export interface DatasetFile {
  fileId: string;
  fileName: string;
  numRows: number;
  numColumns: number;
  processingStatus: string;
  uploadedTimestamp: string;
}

export interface Dataset {
  id: string;
  name: string;
  files: DatasetFile[];
  generatorConfig?: Record<string, string>;
  generatorDefault?: string;
}

export interface DatasetUploadResponse {
  updatedDataset: Dataset;
  uploadedFileId?: string;
  uploadedFile?: DatasetFile;
}

export interface FileRedactionJob {
  jobId: string;
  fileName: string;
}

// Bytes-in-payload upload contract. The MCP layer is responsible for
// producing this from either a base64 input (hosted mode) or a local
// file path (local-files mode); the client itself never reads the
// caller's filesystem.
export interface UploadFilePayload {
  fileName: string;
  mimeType: string;
  content: Buffer;
}

export interface FileJob {
  id: string;
  status: string;
  errorMessages: string | null;
  startTime: string | null;
  endTime: string | null;
  publishedTime: string;
  jobType: string;
  fileName?: string;
}

export type GeneratorHandling =
  | "Redaction"
  | "Synthesis"
  | "GroupingSynthesis"
  | "ReplacementSynthesis"
  | "Off";

export interface GeneratorConfig {
  [entityType: string]: GeneratorHandling;
}

export interface LabelCustomList {
  strings?: string[];
  regexes?: string[];
}

export interface GeneratorMetadataEntry {
  version?: "V1" | "V2";
  customGenerator?: string;
  swaps?: Record<string, string>;
}

export interface RedactOptions {
  generatorConfig?: GeneratorConfig;
  generatorDefault?: GeneratorHandling;
  generatorMetadata?: Record<string, GeneratorMetadataEntry>;
  customEntities?: string[];
  labelBlockLists?: Record<string, LabelCustomList>;
  labelAllowLists?: Record<string, LabelCustomList>;
  recordApiRequest?: boolean;
}

export interface JsonRedactOptions extends RedactOptions {
  jsonPathAllowLists?: Record<string, string[]>;
  jsonPathIgnorePaths?: string[];
}

export type ModelBasedEntityFileSource = "Local" | "S3" | "Azure" | "GoogleCloud";

export type ModelBasedEntityStatus =
  | "TestDataSetup"
  | "GuidelinesRefinement"
  | "PreTraining"
  | "Training"
  | "Ready";

export type ModelBasedEntityVersionStatus =
  | "Annotating"
  | "QueuedForSuggestions"
  | "GeneratingSuggestions"
  | "Ready"
  | "Failed";

export type ModelBasedEntityTrainedModelStatus =
  | "WaitingForFiles"
  | "Annotating"
  | "ReadyForTraining"
  | "Training"
  | "Ready"
  | "Failed";

export type ModelBasedEntityFileStatus =
  | "QueuedForAnalysis"
  | "Analyzing"
  | "QueuedForAnnotation"
  | "Annotating"
  | "ReadyForReview"
  | "ReviewInProgress"
  | "Reviewed"
  | "Failed";

export type ModelBasedEntityFileVersionStatus =
  | "Attached"
  | "QueuedForAnnotation"
  | "Annotating"
  | "PendingReview"
  | "Annotated"
  | "Failed";

export type ModelBasedEntityTrainingFileStatus =
  | "QueuedForAnalysis"
  | "Analyzing"
  | "Ready"
  | "Failed";

export interface ModelBasedEntityAnnotationSpan {
  start: number;
  end: number;
}

export interface CreateModelBasedEntityRequest {
  name: string;
  guidelines: string;
}

export interface CreateEntityVersionRequest {
  guidelines: string;
}

export interface UpdateModelBasedEntityRequest {
  [key: string]: unknown;
}

export interface SaveEntityGroundTruthRequest {
  annotations: ModelBasedEntityAnnotationSpan[];
  markAsReviewed: boolean;
}

export interface CreateTrainedModelRequest {
  versionId: string;
}

export interface ModelBasedEntityApiModel {
  id: string;
  name: string;
  displayName: string;
  fileSource: ModelBasedEntityFileSource;
  status: ModelBasedEntityStatus;
  activeModelId: string | null;
  datasetIds: string[];
  createdByUserId: string;
  lastModifiedDate: string;
}

export interface ModelBasedEntityFileMinimalApiModel {
  id: string;
  deleted: boolean;
  fileName: string;
  filePath: string | null;
  minimumVersionId: string;
  status: ModelBasedEntityFileStatus;
  errorType: string | null;
  errorDetails: string | null;
  createdAt: string;
}

export interface ModelBasedEntityFileFullApiModel extends ModelBasedEntityFileMinimalApiModel {
  content: string;
  groundTruth: ModelBasedEntityAnnotationSpan[];
}

export interface ModelBasedEntityFileVersionRecordWithAnnotations {
  id: string;
  fileId: string;
  versionId: string;
  deleted: boolean;
  fileName: string;
  filePath: string | null;
  numEntities: number;
  f1Score: number;
  recallScore: number;
  precisionScore: number;
  status: ModelBasedEntityFileVersionStatus;
  errorType: string | null;
  errorDetails: string | null;
  createdAt: string;
  content: string;
  annotations: ModelBasedEntityAnnotationSpan[];
}

export interface ModelBasedEntityVersionApiModel {
  id: string;
  entityId: string;
  versionNumber: number;
  guidelines: string;
  entityCount: number;
  f1Score: number;
  recallScore: number;
  precisionScore: number;
  status: ModelBasedEntityVersionStatus;
  errorType: string | null;
  errorDetails: string | null;
  files: ModelBasedEntityFileVersionRecordWithAnnotations[];
}

export interface ModelBasedEntitySuggestedGuidelinesApiModel {
  guidelines: string;
}

export interface ModelBasedEntityTrainedModelApiModel {
  id: string;
  number: number;
  entityId: string;
  versionId: string;
  isActive: boolean;
  status: ModelBasedEntityTrainedModelStatus;
  progress: number;
  benchmarkScore: number;
  entityCount: number;
  fileCount: number;
}

export interface ModelBasedEntityModelTrainingFileApiModel {
  id: string;
  fileId: string;
  fileName: string;
  deleted: boolean;
  createdAt: string;
  numEntities?: number;
  [key: string]: unknown;
}

export interface ModelBasedEntityModelTrainingFileFullApiModel extends ModelBasedEntityModelTrainingFileApiModel {
  content: string;
  annotations: ModelBasedEntityAnnotationSpan[];
}

export interface ModelBasedEntityDetectedEntityApiModel {
  name: string;
  count: number;
  [key: string]: unknown;
}

export interface ModelBasedEntityTrainingFileApiModel {
  id: string;
  deleted: boolean;
  entityId: string;
  fileName: string;
  filePath: string | null;
  status: ModelBasedEntityTrainingFileStatus;
  createdAt: string;
}

export interface ModelBasedEntityTrainingFileFullApiModel extends ModelBasedEntityTrainingFileApiModel {
  content: string;
}

export interface ListEntityTrainingFilesOptions {
  search?: string;
  offset?: number;
  limit?: number;
}

export interface ListAllModelBasedEntitiesOptions extends ListEntityTrainingFilesOptions {
  users?: string[];
  statuses?: string[];
  sortBy?: string;
  sortDirection?: string;
}

export interface ListModelTrainingFilesOptions extends ListEntityTrainingFilesOptions {}

export interface ListModelDetectedEntitiesOptions extends ListEntityTrainingFilesOptions {}

export interface PaginatedModelBasedEntityListResponse {
  records: ModelBasedEntityApiModel[];
  offset?: number;
  limit?: number;
  pageNumber?: number;
  totalPages?: number;
  totalRecords: number;
  absoluteTotalRecords?: number;
  hasPreviousPage?: boolean;
  hasNextPage?: boolean;
  search?: string;
  users?: string[];
  statuses?: string[];
  sortBy?: string;
  sortDirection?: string;
}

export interface ModelBasedEntityTrainingFileListResponse {
  files: ModelBasedEntityTrainingFileApiModel[];
  search?: string;
  offset?: number;
  limit?: number;
  totalCount: number;
}

export interface ModelBasedEntityModelTrainingFileListResponse {
  files: ModelBasedEntityModelTrainingFileApiModel[];
  search?: string;
  offset?: number;
  limit?: number;
  totalCount: number;
  absoluteTotalCount?: number;
  totalPages?: number;
}

export interface ModelBasedEntityDetectedEntityListResponse {
  entities: ModelBasedEntityDetectedEntityApiModel[];
  search?: string;
  offset?: number;
  limit?: number;
  totalCount: number;
}

export interface StartModelTrainingResponse {
  [key: string]: unknown;
}

export interface ActivateTrainedModelResponse {
  [key: string]: unknown;
}

export interface ActivateEntityForDatasetResponse {
  [key: string]: unknown;
}

export interface DeactivateEntityForDatasetResponse {
  [key: string]: unknown;
}

export interface ModelBasedEntityActionResponse {
  [key: string]: unknown;
}

class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  get inflight(): number {
    return this.active;
  }

  get pending(): number {
    return this.queue.length;
  }
}

export class TextualClient {
  private baseUrl: string;
  private apiKey: string;
  private logger?: Logger;
  private semaphore: Semaphore;

  constructor(baseUrl: string, apiKey: string, logger?: Logger, maxConcurrent = 50) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.logger = logger;
    this.semaphore = new Semaphore(maxConcurrent);
  }

  private isRetryableError(err: unknown): boolean {
    if (err instanceof TypeError) return true; // fetch network errors
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "ECONNRESET" || code === "ECONNREFUSED" || code === "UND_ERR_SOCKET" || code === "EPIPE";
  }

  private async request(
    endpoint: string,
    options: RequestInit = {},
    signal?: AbortSignal
  ): Promise<Response> {
    const url = `${this.baseUrl}${endpoint}`;
    const method = options.method || "GET";
    const headers: Record<string, string> = {
      Authorization: this.apiKey,
      "User-Agent": USER_AGENT,
      ...((options.headers as Record<string, string>) || {}),
    };
    await this.semaphore.acquire();
    const start = Date.now();
    this.logger?.info("api_request_start", { method, endpoint, inflight: this.semaphore.inflight, pending: this.semaphore.pending });
    try {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(url, { ...options, headers, signal });
          const durationMs = Date.now() - start;
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            this.logger?.error("api_request_error", { method, endpoint, status: res.status, body, durationMs });
            let detail = body;
            try {
              const parsed = JSON.parse(body);
              detail = parsed.message || parsed.detail || parsed.title || body;
            } catch {
              // body is plain text, use as-is
            }
            const err = new Error(detail);
            (err as any).statusCode = res.status;
            (err as any).endpoint = endpoint;
            throw err;
          }
          this.logger?.info("api_request_complete", { method, endpoint, status: res.status, durationMs });
          return res;
        } catch (err) {
          if (attempt === 0 && this.isRetryableError(err)) {
            this.logger?.info("api_request_retry", { method, endpoint, error: String(err), attempt: attempt + 1 });
            lastErr = err;
            continue;
          }
          throw err;
        }
      }
      throw lastErr;
    } finally {
      this.semaphore.release();
    }
  }

  private async json<T>(endpoint: string, options: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((options.headers as Record<string, string>) || {}),
    };
    const res = await this.request(endpoint, { ...options, headers }, signal);
    return res.json() as Promise<T>;
  }

  private async jsonOrNull<T>(res: Response): Promise<T | null> {
    const text = await res.text();
    if (!text.trim()) return null;
    return JSON.parse(text) as T;
  }

  private toBlobPart(fileBuffer: Buffer): ArrayBuffer {
    return Uint8Array.from(fileBuffer).buffer;
  }

  private createModelBasedEntityFileUploadFormData(payload: UploadFilePayload): FormData {
    const formData = new FormData();
    formData.append(
      "document",
      new Blob([JSON.stringify({ fileName: payload.fileName })], { type: "application/json" })
    );
    formData.append("file", new Blob([this.toBlobPart(payload.content)], { type: payload.mimeType }), payload.fileName);
    return formData;
  }

  private async uploadModelBasedEntityFile<T>(
    entityId: string,
    kind: "test" | "training",
    payload: UploadFilePayload,
    signal?: AbortSignal
  ): Promise<T> {
    const formData = this.createModelBasedEntityFileUploadFormData(payload);
    const encodedEntityId = encodeURIComponent(entityId);
    const res = await this.request(`/api/model-based-entities/${encodedEntityId}/${kind}/files`, {
      method: "POST",
      body: formData,
    }, signal);
    return res.json() as Promise<T>;
  }

  private unwrapModelBasedEntity(
    data: ModelBasedEntityApiModel | { entity: ModelBasedEntityApiModel; version?: ModelBasedEntityVersionApiModel }
  ): ModelBasedEntityApiModel {
    return typeof data === "object" && data !== null && "entity" in data ? data.entity : data;
  }

  private normalizePaginatedModelBasedEntityListResponse(
    data:
      | ModelBasedEntityApiModel[]
      | {
          records?: ModelBasedEntityApiModel[];
          entities?: ModelBasedEntityApiModel[];
          items?: ModelBasedEntityApiModel[];
          customEntities?: ModelBasedEntityApiModel[];
          offset?: number;
          limit?: number;
          pageNumber?: number;
          totalPages?: number;
          totalRecords?: number;
          absoluteTotalRecords?: number;
          hasPreviousPage?: boolean;
          hasNextPage?: boolean;
          search?: string;
          users?: string[];
          statuses?: string[];
          sortBy?: string;
          sortDirection?: string;
        },
    options: ListAllModelBasedEntitiesOptions = {}
  ): PaginatedModelBasedEntityListResponse {
    if (Array.isArray(data)) {
      return {
        records: data,
        ...(typeof options.offset === "number" ? { offset: options.offset } : {}),
        ...(typeof options.limit === "number" ? { limit: options.limit } : {}),
        ...(typeof options.search === "string" ? { search: options.search } : {}),
        ...(Array.isArray(options.users) && options.users.length > 0 ? { users: options.users } : {}),
        ...(Array.isArray(options.statuses) && options.statuses.length > 0 ? { statuses: options.statuses } : {}),
        ...(typeof options.sortBy === "string" ? { sortBy: options.sortBy } : {}),
        ...(typeof options.sortDirection === "string" ? { sortDirection: options.sortDirection } : {}),
        totalRecords: data.length,
      };
    }

    const records = Array.isArray(data.records)
      ? data.records
      : Array.isArray(data.entities)
        ? data.entities
        : Array.isArray(data.items)
          ? data.items
          : Array.isArray(data.customEntities)
            ? data.customEntities
            : null;

    if (!records) {
      throw new Error("Unexpected custom entities response shape");
    }

    return {
      records,
      ...(typeof data.offset === "number"
        ? { offset: data.offset }
        : typeof options.offset === "number"
          ? { offset: options.offset }
          : {}),
      ...(typeof data.limit === "number"
        ? { limit: data.limit }
        : typeof options.limit === "number"
          ? { limit: options.limit }
          : {}),
      ...(typeof data.pageNumber === "number" ? { pageNumber: data.pageNumber } : {}),
      ...(typeof data.totalPages === "number" ? { totalPages: data.totalPages } : {}),
      ...(typeof data.absoluteTotalRecords === "number" ? { absoluteTotalRecords: data.absoluteTotalRecords } : {}),
      ...(typeof data.hasPreviousPage === "boolean" ? { hasPreviousPage: data.hasPreviousPage } : {}),
      ...(typeof data.hasNextPage === "boolean" ? { hasNextPage: data.hasNextPage } : {}),
      ...(typeof data.search === "string"
        ? { search: data.search }
        : typeof options.search === "string"
          ? { search: options.search }
          : {}),
      ...(Array.isArray(data.users) && data.users.length > 0
        ? { users: data.users }
        : Array.isArray(options.users) && options.users.length > 0
          ? { users: options.users }
          : {}),
      ...(Array.isArray(data.statuses) && data.statuses.length > 0
        ? { statuses: data.statuses }
        : Array.isArray(options.statuses) && options.statuses.length > 0
          ? { statuses: options.statuses }
          : {}),
      ...(typeof data.sortBy === "string"
        ? { sortBy: data.sortBy }
        : typeof options.sortBy === "string"
          ? { sortBy: options.sortBy }
          : {}),
      ...(typeof data.sortDirection === "string"
        ? { sortDirection: data.sortDirection }
        : typeof options.sortDirection === "string"
          ? { sortDirection: options.sortDirection }
          : {}),
      totalRecords:
        typeof data.totalRecords === "number"
          ? data.totalRecords
          : records.length,
    };
  }

  private normalizeModelBasedEntityTrainingFileListResponse(
    data:
      | ModelBasedEntityTrainingFileApiModel[]
      | {
          files?: ModelBasedEntityTrainingFileApiModel[];
          trainingFiles?: ModelBasedEntityTrainingFileApiModel[];
          items?: ModelBasedEntityTrainingFileApiModel[];
          search?: string;
          offset?: number;
          limit?: number;
          totalCount?: number;
          total?: number;
          count?: number;
        },
    options: ListEntityTrainingFilesOptions = {}
  ): ModelBasedEntityTrainingFileListResponse {
    if (Array.isArray(data)) {
      return {
        files: data,
        ...(typeof options.search === "string" ? { search: options.search } : {}),
        ...(typeof options.offset === "number" ? { offset: options.offset } : {}),
        ...(typeof options.limit === "number" ? { limit: options.limit } : {}),
        totalCount: data.length,
      };
    }

    const files = Array.isArray(data.files)
      ? data.files
      : Array.isArray(data.trainingFiles)
        ? data.trainingFiles
        : Array.isArray(data.items)
          ? data.items
          : null;

    if (!files) {
      throw new Error("Unexpected entity training files response shape");
    }

    return {
      files,
      ...(typeof data.search === "string"
        ? { search: data.search }
        : typeof options.search === "string"
          ? { search: options.search }
          : {}),
      ...(typeof data.offset === "number"
        ? { offset: data.offset }
        : typeof options.offset === "number"
          ? { offset: options.offset }
          : {}),
      ...(typeof data.limit === "number"
        ? { limit: data.limit }
        : typeof options.limit === "number"
          ? { limit: options.limit }
          : {}),
      totalCount:
        typeof data.totalCount === "number"
          ? data.totalCount
          : typeof data.total === "number"
            ? data.total
            : typeof data.count === "number"
              ? data.count
              : files.length,
    };
  }

  private normalizeTrainedModelListResponse(
    data:
      | ModelBasedEntityTrainedModelApiModel[]
      | {
          models?: ModelBasedEntityTrainedModelApiModel[];
          trainedModels?: ModelBasedEntityTrainedModelApiModel[];
          items?: ModelBasedEntityTrainedModelApiModel[];
          records?: ModelBasedEntityTrainedModelApiModel[];
        }
  ): ModelBasedEntityTrainedModelApiModel[] {
    if (Array.isArray(data)) {
      return data;
    }

    const models = Array.isArray(data.models)
      ? data.models
      : Array.isArray(data.trainedModels)
        ? data.trainedModels
        : Array.isArray(data.items)
          ? data.items
          : Array.isArray(data.records)
            ? data.records
            : null;

    if (!models) {
      throw new Error("Unexpected trained models response shape");
    }

    return models;
  }

  private normalizeModelTrainingFileListResponse(
    data:
      | ModelBasedEntityModelTrainingFileApiModel[]
      | {
          files?: ModelBasedEntityModelTrainingFileApiModel[];
          modelTrainingFiles?: ModelBasedEntityModelTrainingFileApiModel[];
          records?: ModelBasedEntityModelTrainingFileApiModel[];
          items?: ModelBasedEntityModelTrainingFileApiModel[];
          search?: string;
          offset?: number;
          limit?: number;
          totalCount?: number;
          totalRecords?: number;
          total?: number;
          count?: number;
          absoluteTotalRecords?: number;
          totalPages?: number;
        },
    options: ListModelTrainingFilesOptions = {}
  ): ModelBasedEntityModelTrainingFileListResponse {
    if (Array.isArray(data)) {
      return {
        files: data,
        ...(typeof options.search === "string" ? { search: options.search } : {}),
        ...(typeof options.offset === "number" ? { offset: options.offset } : {}),
        ...(typeof options.limit === "number" ? { limit: options.limit } : {}),
        totalCount: data.length,
      };
    }

    const files = Array.isArray(data.files)
      ? data.files
      : Array.isArray(data.modelTrainingFiles)
        ? data.modelTrainingFiles
        : Array.isArray(data.records)
          ? data.records
          : Array.isArray(data.items)
            ? data.items
            : null;

    if (!files) {
      throw new Error("Unexpected model training files response shape");
    }

    return {
      files,
      ...(typeof data.search === "string"
        ? { search: data.search }
        : typeof options.search === "string"
          ? { search: options.search }
          : {}),
      ...(typeof data.offset === "number"
        ? { offset: data.offset }
        : typeof options.offset === "number"
          ? { offset: options.offset }
          : {}),
      ...(typeof data.limit === "number"
        ? { limit: data.limit }
        : typeof options.limit === "number"
          ? { limit: options.limit }
          : {}),
      ...(typeof data.absoluteTotalRecords === "number" ? { absoluteTotalCount: data.absoluteTotalRecords } : {}),
      ...(typeof data.totalPages === "number" ? { totalPages: data.totalPages } : {}),
      totalCount:
        typeof data.totalCount === "number"
          ? data.totalCount
          : typeof data.totalRecords === "number"
            ? data.totalRecords
            : typeof data.total === "number"
              ? data.total
              : typeof data.count === "number"
                ? data.count
                : files.length,
    };
  }

  private normalizeModelDetectedEntityListResponse(
    data:
      | ModelBasedEntityDetectedEntityApiModel[]
      | {
          entities?: ModelBasedEntityDetectedEntityApiModel[];
          records?: ModelBasedEntityDetectedEntityApiModel[];
          items?: ModelBasedEntityDetectedEntityApiModel[];
          search?: string;
          offset?: number;
          limit?: number;
          totalCount?: number;
          totalRecords?: number;
          total?: number;
          count?: number;
        },
    options: ListModelDetectedEntitiesOptions = {}
  ): ModelBasedEntityDetectedEntityListResponse {
    if (Array.isArray(data)) {
      return {
        entities: data,
        ...(typeof options.search === "string" ? { search: options.search } : {}),
        ...(typeof options.offset === "number" ? { offset: options.offset } : {}),
        ...(typeof options.limit === "number" ? { limit: options.limit } : {}),
        totalCount: data.length,
      };
    }

    const entities = Array.isArray(data.entities)
      ? data.entities
      : Array.isArray(data.records)
        ? data.records
        : Array.isArray(data.items)
          ? data.items
          : null;

    if (!entities) {
      throw new Error("Unexpected model detected entities response shape");
    }

    return {
      entities,
      ...(typeof data.search === "string"
        ? { search: data.search }
        : typeof options.search === "string"
          ? { search: options.search }
          : {}),
      ...(typeof data.offset === "number"
        ? { offset: data.offset }
        : typeof options.offset === "number"
          ? { offset: options.offset }
          : {}),
      ...(typeof data.limit === "number"
        ? { limit: data.limit }
        : typeof options.limit === "number"
          ? { limit: options.limit }
          : {}),
      totalCount:
        typeof data.totalCount === "number"
          ? data.totalCount
          : typeof data.totalRecords === "number"
            ? data.totalRecords
            : typeof data.total === "number"
              ? data.total
              : typeof data.count === "number"
                ? data.count
                : entities.length,
    };
  }

  // --- Text Redaction ---

  private redactPayload(opts: RedactOptions): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    if (opts.generatorConfig) payload.generatorConfig = opts.generatorConfig;
    if (opts.generatorDefault) payload.generatorDefault = opts.generatorDefault;
    if (opts.generatorMetadata) payload.generatorMetadata = opts.generatorMetadata;
    if (opts.customEntities) payload.customPiiEntityIds = opts.customEntities;
    if (opts.labelBlockLists) payload.labelBlockLists = opts.labelBlockLists;
    if (opts.labelAllowLists) payload.labelAllowLists = opts.labelAllowLists;
    return payload;
  }

  async redactText(text: string, opts: RedactOptions = {}, signal?: AbortSignal): Promise<RedactionResponse> {
    return this.json("/api/Redact", {
      method: "POST",
      body: JSON.stringify({ ...this.redactPayload(opts), text }),
    }, signal);
  }

  async redactBulk(texts: string[], opts: RedactOptions = {}, signal?: AbortSignal): Promise<BulkRedactionResponse> {
    return this.json("/api/Redact/bulk", {
      method: "POST",
      body: JSON.stringify({ ...this.redactPayload(opts), bulkText: texts }),
    }, signal);
  }

  async redactJson(jsonString: string, opts: JsonRedactOptions = {}, signal?: AbortSignal): Promise<RedactionResponse> {
    const payload: Record<string, unknown> = {
      ...this.redactPayload(opts),
      jsonText: jsonString,
    };
    if (opts.jsonPathAllowLists) payload.jsonPathAllowLists = opts.jsonPathAllowLists;
    if (opts.jsonPathIgnorePaths) payload.jsonPathIgnorePaths = opts.jsonPathIgnorePaths;
    return this.json("/api/Redact/json", {
      method: "POST",
      body: JSON.stringify(payload),
    }, signal);
  }

  async redactXml(xmlString: string, opts: RedactOptions = {}, signal?: AbortSignal): Promise<RedactionResponse> {
    return this.json("/api/Redact/xml", {
      method: "POST",
      body: JSON.stringify({ ...this.redactPayload(opts), xmlText: xmlString }),
    }, signal);
  }

  async redactHtml(htmlString: string, opts: RedactOptions = {}, signal?: AbortSignal): Promise<RedactionResponse> {
    return this.json("/api/Redact/html", {
      method: "POST",
      body: JSON.stringify({ ...this.redactPayload(opts), htmlText: htmlString }),
    }, signal);
  }

  // --- PII Types ---

  async getPiiTypes(): Promise<string[]> {
    return this.json("/api/Redact/pii_types");
  }

  // --- File Redaction (Unattached) ---

  async startFileRedaction(payload: UploadFilePayload, signal?: AbortSignal): Promise<FileRedactionJob> {
    const formData = new FormData();
    formData.append(
      "document",
      new Blob(
        [JSON.stringify({
          fileName: payload.fileName,
          csvConfig: {},
          datasetId: "",
          customPiiEntityIds: [],
        })],
        { type: "application/json" }
      )
    );
    formData.append("file", new Blob([this.toBlobPart(payload.content)], { type: payload.mimeType }), payload.fileName);

    const res = await this.request("/api/unattachedfile/upload", {
      method: "POST",
      body: formData,
    }, signal);
    const data = await res.json();
    return { jobId: data.jobId ?? data.id, fileName: payload.fileName };
  }

  async listFileJobs(from?: string): Promise<FileJob[]> {
    const query = from ? `?from=${encodeURIComponent(from)}` : "";
    return this.json(`/api/unattachedfile${query}`);
  }

  async getFileJob(jobId: string): Promise<FileJob> {
    return this.json(`/api/unattachedfile/${jobId}`);
  }

  async getJobErrorLogs(jobId: string): Promise<string> {
    const res = await this.request(`/api/JobLogs/${jobId}/error/download`);
    return res.text();
  }

  async downloadRedactedFile(
    jobId: string,
    opts: RedactOptions = {},
    signal?: AbortSignal
  ): Promise<Buffer> {
    const res = await this.request(`/api/unattachedfile/${jobId}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.redactPayload(opts)),
    }, signal);
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  // --- Dataset Management ---

  async listDatasets(): Promise<Dataset[]> {
    return this.json("/api/Dataset");
  }

  async getDataset(datasetId: string): Promise<Dataset> {
    return this.json(`/api/Dataset/${datasetId}`);
  }

  async createDataset(name: string): Promise<Dataset> {
    return this.json("/api/Dataset", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  async uploadFileToDataset(datasetId: string, payload: UploadFilePayload): Promise<DatasetUploadResponse> {
    const formData = new FormData();
    formData.append(
      "document",
      new Blob(
        [JSON.stringify({
          fileName: payload.fileName,
          csvConfig: {},
          datasetId,
          customPiiEntityIds: [],
        })],
        { type: "application/json" }
      )
    );
    formData.append("file", new Blob([this.toBlobPart(payload.content)], { type: payload.mimeType }), payload.fileName);

    const res = await this.request(`/api/Dataset/${datasetId}/files/upload`, {
      method: "POST",
      body: formData,
    });
    const data: unknown = await res.json();
    const updatedDataset =
      typeof data === "object" && data !== null && "updatedDataset" in data
        ? (data as { updatedDataset?: unknown }).updatedDataset
        : undefined;

    if (
      typeof updatedDataset !== "object"
      || updatedDataset === null
      || !("files" in updatedDataset)
      || !Array.isArray((updatedDataset as { files?: unknown }).files)
    ) {
      throw new Error(
        "Invalid response from dataset file upload: expected updatedDataset.files array."
      );
    }

    const validatedData = data as DatasetUploadResponse;
    const uploadedFile = validatedData.updatedDataset.files.find((file) => file.fileId === validatedData.uploadedFileId)
      ?? validatedData.updatedDataset.files.find((file) => file.fileName === payload.fileName);
    return { ...validatedData, uploadedFile };
  }

  async downloadDatasetFile(
    datasetId: string,
    fileId: string
  ): Promise<Buffer> {
    const res = await this.request(
      `/api/Dataset/${datasetId}/files/${fileId}/download`
    );
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  async downloadAllDatasetFiles(datasetId: string): Promise<Buffer> {
    const res = await this.request(
      `/api/Dataset/${datasetId}/files/download_all`
    );
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  // --- Model-based Entities (Phase 1) ---

  async createModelBasedEntity(
    name: string,
    guidelines: string
  ): Promise<ModelBasedEntityApiModel> {
    const data = await this.json<
      ModelBasedEntityApiModel
      | { entity: ModelBasedEntityApiModel; version?: ModelBasedEntityVersionApiModel }
    >("/api/model-based-entities", {
      method: "POST",
      body: JSON.stringify({ name, guidelines } satisfies CreateModelBasedEntityRequest),
    });

    return this.unwrapModelBasedEntity(data);
  }

  async listModelBasedEntities(): Promise<ModelBasedEntityApiModel[]> {
    const data = await this.json<
      ModelBasedEntityApiModel[]
      | { entities: ModelBasedEntityApiModel[] }
    >("/api/model-based-entities/active");

    return Array.isArray(data) ? data : data.entities;
  }

  async listAllModelBasedEntities(
    options: ListAllModelBasedEntitiesOptions = {}
  ): Promise<PaginatedModelBasedEntityListResponse> {
    const search = options.search?.trim();
    const users = options.users?.map((user) => user.trim()).filter((user) => user.length > 0);
    const statuses = options.statuses?.map((status) => status.trim()).filter((status) => status.length > 0);
    const sortBy = options.sortBy?.trim();
    const sortDirection = options.sortDirection?.trim();
    const params = new URLSearchParams();
    params.set("entityType", "ModelBased");

    if (search) {
      params.set("search", search);
    }

    if (typeof options.offset === "number") {
      params.set("offset", String(options.offset));
    }

    if (typeof options.limit === "number") {
      params.set("limit", String(options.limit));
    }

    for (const user of users ?? []) {
      params.append("users", user);
    }

    for (const status of statuses ?? []) {
      params.append("statuses", status);
    }

    if (sortBy) {
      params.set("sortBy", sortBy);
    }

    if (sortDirection) {
      params.set("sortDirection", sortDirection);
    }

    const query = params.toString();
    const data = await this.json<
      | ModelBasedEntityApiModel[]
      | {
          records?: ModelBasedEntityApiModel[];
          entities?: ModelBasedEntityApiModel[];
          items?: ModelBasedEntityApiModel[];
          customEntities?: ModelBasedEntityApiModel[];
          offset?: number;
          limit?: number;
          pageNumber?: number;
          totalPages?: number;
          totalRecords?: number;
          absoluteTotalRecords?: number;
          hasPreviousPage?: boolean;
          hasNextPage?: boolean;
          search?: string;
          users?: string[];
          statuses?: string[];
          sortBy?: string;
          sortDirection?: string;
        }
    >(`/api/custom-entities${query ? `?${query}` : ""}`);

    return this.normalizePaginatedModelBasedEntityListResponse(data, {
      offset: options.offset,
      limit: options.limit,
      search,
      users,
      statuses,
      sortBy,
      sortDirection,
    });
  }

  async getModelBasedEntity(entityId: string): Promise<ModelBasedEntityApiModel> {
    const encodedEntityId = encodeURIComponent(entityId);
    const data = await this.json<
      ModelBasedEntityApiModel
      | { entity: ModelBasedEntityApiModel; version?: ModelBasedEntityVersionApiModel }
    >(`/api/model-based-entities/${encodedEntityId}`);

    return this.unwrapModelBasedEntity(data);
  }

  async updateModelBasedEntity(
    entityId: string,
    updates: UpdateModelBasedEntityRequest
  ): Promise<ModelBasedEntityApiModel> {
    const encodedEntityId = encodeURIComponent(entityId);
    const data = await this.json<
      ModelBasedEntityApiModel
      | { entity: ModelBasedEntityApiModel; version?: ModelBasedEntityVersionApiModel }
    >(`/api/model-based-entities/${encodedEntityId}`, {
      method: "PUT",
      body: JSON.stringify(updates),
    });

    return this.unwrapModelBasedEntity(data);
  }

  async deleteModelBasedEntity(
    entityId: string
  ): Promise<ModelBasedEntityActionResponse | ModelBasedEntityApiModel | null> {
    const encodedEntityId = encodeURIComponent(entityId);
    const res = await this.request(`/api/model-based-entities/${encodedEntityId}`, {
      method: "DELETE",
    });
    return this.jsonOrNull<ModelBasedEntityActionResponse | ModelBasedEntityApiModel>(res);
  }

  async createEntityVersion(
    entityId: string,
    guidelines: string
  ): Promise<ModelBasedEntityVersionApiModel> {
    const encodedEntityId = encodeURIComponent(entityId);
    return this.json(`/api/model-based-entities/${encodedEntityId}/versions`, {
      method: "POST",
      body: JSON.stringify({ guidelines } satisfies CreateEntityVersionRequest),
    });
  }

  async getSuggestedGuidelines(
    entityId: string,
    versionId: string
  ): Promise<ModelBasedEntitySuggestedGuidelinesApiModel> {
    const encodedEntityId = encodeURIComponent(entityId);
    const encodedVersionId = encodeURIComponent(versionId);
    const data = await this.json<ModelBasedEntitySuggestedGuidelinesApiModel | string>(
      `/api/model-based-entities/${encodedEntityId}/versions/${encodedVersionId}/suggested-guidelines`,
      {}
    );
    return typeof data === "string" ? { guidelines: data } : data;
  }

  async listEntityVersions(entityId: string): Promise<ModelBasedEntityVersionApiModel[]> {
    const encodedEntityId = encodeURIComponent(entityId);
    const data = await this.json<
      ModelBasedEntityVersionApiModel[]
      | { versions: ModelBasedEntityVersionApiModel[] | Record<string, string> }
    >(`/api/model-based-entities/${encodedEntityId}/versions`);

    if (Array.isArray(data)) {
      return data;
    }

    const { versions } = data;

    if (Array.isArray(versions)) {
      return versions;
    }

    if (versions && typeof versions === "object") {
      const versionIds = Object.values(versions).filter((versionId): versionId is string => typeof versionId === "string");

      if (versionIds.length === Object.keys(versions).length) {
        return Promise.all(versionIds.map((versionId) => this.getEntityVersion(entityId, versionId)));
      }
    }

    throw new Error("Unexpected entity versions response shape");
  }

  async retryVersionAnnotation(
    entityId: string,
    versionId: string
  ): Promise<ModelBasedEntityActionResponse | ModelBasedEntityVersionApiModel | null> {
    const encodedEntityId = encodeURIComponent(entityId);
    const encodedVersionId = encodeURIComponent(versionId);
    const res = await this.request(`/api/model-based-entities/${encodedEntityId}/versions/${encodedVersionId}/retry`, {
      method: "POST",
    });
    return this.jsonOrNull<ModelBasedEntityActionResponse | ModelBasedEntityVersionApiModel>(res);
  }

  async retrySuggestedGuidelines(
    entityId: string,
    versionId: string
  ): Promise<ModelBasedEntityActionResponse | ModelBasedEntityVersionApiModel | null> {
    const encodedEntityId = encodeURIComponent(entityId);
    const encodedVersionId = encodeURIComponent(versionId);
    const res = await this.request(
      `/api/model-based-entities/${encodedEntityId}/versions/${encodedVersionId}/suggested-guidelines/retry`,
      {
        method: "POST",
      }
    );
    return this.jsonOrNull<ModelBasedEntityActionResponse | ModelBasedEntityVersionApiModel>(res);
  }

  async getSupportedEntityFileTypes(): Promise<string[]> {
    const data = await this.json<
      string[]
      | { supportedFileTypes?: string[]; fileTypes?: string[] }
    >("/api/model-based-entities/supported-file-types");

    if (Array.isArray(data)) {
      return data;
    }

    if (Array.isArray(data.supportedFileTypes)) {
      return data.supportedFileTypes;
    }

    if (Array.isArray(data.fileTypes)) {
      return data.fileTypes;
    }

    throw new Error("Unexpected supported entity file types response shape");
  }

  async uploadEntityTestFile(
    entityId: string,
    payload: UploadFilePayload
  ): Promise<ModelBasedEntityFileMinimalApiModel> {
    return this.uploadModelBasedEntityFile(entityId, "test", payload);
  }

  async listEntityTestFiles(entityId: string): Promise<ModelBasedEntityFileMinimalApiModel[]> {
    const encodedEntityId = encodeURIComponent(entityId);
    const data = await this.json<
      ModelBasedEntityFileMinimalApiModel[]
      | { files?: ModelBasedEntityFileMinimalApiModel[]; testFiles?: ModelBasedEntityFileMinimalApiModel[] }
    >(`/api/model-based-entities/${encodedEntityId}/test/files`);

    if (Array.isArray(data)) {
      return data;
    }

    if (Array.isArray(data.files)) {
      return data.files;
    }

    if (Array.isArray(data.testFiles)) {
      return data.testFiles;
    }

    throw new Error("Unexpected entity test files response shape");
  }

  async deleteEntityTestFile(
    entityId: string,
    fileId: string
  ): Promise<ModelBasedEntityActionResponse | ModelBasedEntityFileMinimalApiModel | null> {
    const encodedEntityId = encodeURIComponent(entityId);
    const encodedFileId = encodeURIComponent(fileId);
    const res = await this.request(`/api/model-based-entities/${encodedEntityId}/test/files/${encodedFileId}`, {
      method: "DELETE",
    });
    return this.jsonOrNull<ModelBasedEntityActionResponse | ModelBasedEntityFileMinimalApiModel>(res);
  }

  async saveEntityGroundTruth(
    entityId: string,
    fileId: string,
    annotations: ModelBasedEntityAnnotationSpan[],
    markAsReviewed: boolean
  ): Promise<ModelBasedEntityFileFullApiModel | null> {
    const encodedEntityId = encodeURIComponent(entityId);
    const encodedFileId = encodeURIComponent(fileId);
    const request: SaveEntityGroundTruthRequest = { annotations, markAsReviewed };
    const res = await this.request(`/api/model-based-entities/${encodedEntityId}/test/files/${encodedFileId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    return this.jsonOrNull<ModelBasedEntityFileFullApiModel>(res);
  }

  async uploadEntityTrainingFile(
    entityId: string,
    payload: UploadFilePayload
  ): Promise<ModelBasedEntityTrainingFileApiModel> {
    return this.uploadModelBasedEntityFile(entityId, "training", payload);
  }

  async listEntityTrainingFiles(
    entityId: string,
    options: ListEntityTrainingFilesOptions = {}
  ): Promise<ModelBasedEntityTrainingFileListResponse> {
    const encodedEntityId = encodeURIComponent(entityId);
    const search = options.search?.trim();
    const params = new URLSearchParams();

    if (search) {
      params.set("search", search);
    }

    if (typeof options.offset === "number") {
      params.set("offset", String(options.offset));
    }

    if (typeof options.limit === "number") {
      params.set("limit", String(options.limit));
    }

    const query = params.toString();
    const data = await this.json<
      | ModelBasedEntityTrainingFileApiModel[]
      | {
          files?: ModelBasedEntityTrainingFileApiModel[];
          trainingFiles?: ModelBasedEntityTrainingFileApiModel[];
          items?: ModelBasedEntityTrainingFileApiModel[];
          search?: string;
          offset?: number;
          limit?: number;
          totalCount?: number;
          total?: number;
          count?: number;
        }
    >(`/api/model-based-entities/${encodedEntityId}/training/files${query ? `?${query}` : ""}`);

    return this.normalizeModelBasedEntityTrainingFileListResponse(data, {
      ...options,
      search,
    });
  }

  async getEntityTrainingFile(
    entityId: string,
    fileId: string
  ): Promise<ModelBasedEntityTrainingFileFullApiModel> {
    const encodedEntityId = encodeURIComponent(entityId);
    const encodedFileId = encodeURIComponent(fileId);
    return this.json(`/api/model-based-entities/${encodedEntityId}/training/files/${encodedFileId}`);
  }

  async deleteEntityTrainingFile(
    entityId: string,
    fileId: string
  ): Promise<ModelBasedEntityActionResponse | ModelBasedEntityTrainingFileApiModel | null> {
    const encodedEntityId = encodeURIComponent(entityId);
    const encodedFileId = encodeURIComponent(fileId);
    const res = await this.request(`/api/model-based-entities/${encodedEntityId}/training/files/${encodedFileId}`, {
      method: "DELETE",
    });
    return this.jsonOrNull<ModelBasedEntityActionResponse | ModelBasedEntityTrainingFileApiModel>(res);
  }

  async createTrainedModel(
    entityId: string,
    versionId: string
  ): Promise<ModelBasedEntityTrainedModelApiModel> {
    const encodedEntityId = encodeURIComponent(entityId);
    return this.json(`/api/model-based-entities/${encodedEntityId}/training/models`, {
      method: "POST",
      body: JSON.stringify({ versionId } satisfies CreateTrainedModelRequest),
    });
  }

  async listTrainedModels(entityId: string): Promise<ModelBasedEntityTrainedModelApiModel[]> {
    const encodedEntityId = encodeURIComponent(entityId);
    const data = await this.json<
      | ModelBasedEntityTrainedModelApiModel[]
      | {
          models?: ModelBasedEntityTrainedModelApiModel[];
          trainedModels?: ModelBasedEntityTrainedModelApiModel[];
          items?: ModelBasedEntityTrainedModelApiModel[];
          records?: ModelBasedEntityTrainedModelApiModel[];
        }
    >(`/api/model-based-entities/${encodedEntityId}/training/models`);

    return this.normalizeTrainedModelListResponse(data);
  }

  async getTrainedModel(
    entityId: string,
    modelId: string
  ): Promise<ModelBasedEntityTrainedModelApiModel> {
    const encodedEntityId = encodeURIComponent(entityId);
    const encodedModelId = encodeURIComponent(modelId);
    return this.json(`/api/model-based-entities/${encodedEntityId}/training/models/${encodedModelId}`);
  }

  async listModelTrainingFiles(
    entityId: string,
    modelId: string,
    options: ListModelTrainingFilesOptions = {}
  ): Promise<ModelBasedEntityModelTrainingFileListResponse> {
    const encodedEntityId = encodeURIComponent(entityId);
    const encodedModelId = encodeURIComponent(modelId);
    const search = options.search?.trim();
    const params = new URLSearchParams();

    if (search) {
      params.set("search", search);
    }

    if (typeof options.offset === "number") {
      params.set("offset", String(options.offset));
    }

    if (typeof options.limit === "number") {
      params.set("limit", String(options.limit));
    }

    const query = params.toString();
    const data = await this.json<
      | ModelBasedEntityModelTrainingFileApiModel[]
      | {
          files?: ModelBasedEntityModelTrainingFileApiModel[];
          modelTrainingFiles?: ModelBasedEntityModelTrainingFileApiModel[];
          records?: ModelBasedEntityModelTrainingFileApiModel[];
          items?: ModelBasedEntityModelTrainingFileApiModel[];
          search?: string;
          offset?: number;
          limit?: number;
          totalCount?: number;
          totalRecords?: number;
          total?: number;
          count?: number;
          absoluteTotalRecords?: number;
          totalPages?: number;
        }
    >(`/api/model-based-entities/${encodedEntityId}/training/models/${encodedModelId}/files${query ? `?${query}` : ""}`);

    return this.normalizeModelTrainingFileListResponse(data, {
      ...options,
      search,
    });
  }

  async getModelTrainingFile(
    entityId: string,
    modelId: string,
    fileId: string
  ): Promise<ModelBasedEntityModelTrainingFileFullApiModel> {
    const encodedEntityId = encodeURIComponent(entityId);
    const encodedModelId = encodeURIComponent(modelId);
    const encodedFileId = encodeURIComponent(fileId);
    return this.json(`/api/model-based-entities/${encodedEntityId}/training/models/${encodedModelId}/files/${encodedFileId}`);
  }

  async listModelDetectedEntities(
    entityId: string,
    modelId: string,
    options: ListModelDetectedEntitiesOptions = {}
  ): Promise<ModelBasedEntityDetectedEntityListResponse> {
    const encodedEntityId = encodeURIComponent(entityId);
    const encodedModelId = encodeURIComponent(modelId);
    const search = options.search?.trim();
    const params = new URLSearchParams();

    if (search) {
      params.set("search", search);
    }

    if (typeof options.offset === "number") {
      params.set("offset", String(options.offset));
    }

    if (typeof options.limit === "number") {
      params.set("limit", String(options.limit));
    }

    const query = params.toString();
    const data = await this.json<
      | ModelBasedEntityDetectedEntityApiModel[]
      | {
          entities?: ModelBasedEntityDetectedEntityApiModel[];
          records?: ModelBasedEntityDetectedEntityApiModel[];
          items?: ModelBasedEntityDetectedEntityApiModel[];
          search?: string;
          offset?: number;
          limit?: number;
          totalCount?: number;
          totalRecords?: number;
          total?: number;
          count?: number;
        }
    >(`/api/model-based-entities/${encodedEntityId}/training/models/${encodedModelId}/entities-detected${query ? `?${query}` : ""}`);

    return this.normalizeModelDetectedEntityListResponse(data, {
      ...options,
      search,
    });
  }

  async startModelTraining(
    entityId: string,
    modelId: string
  ): Promise<StartModelTrainingResponse | ModelBasedEntityTrainedModelApiModel | null> {
    const encodedEntityId = encodeURIComponent(entityId);
    const encodedModelId = encodeURIComponent(modelId);
    const res = await this.request(`/api/model-based-entities/${encodedEntityId}/training/models/${encodedModelId}/train`, {
      method: "POST",
    });
    return this.jsonOrNull<StartModelTrainingResponse | ModelBasedEntityTrainedModelApiModel>(res);
  }

  async activateTrainedModel(
    entityId: string,
    modelId: string
  ): Promise<ActivateTrainedModelResponse | ModelBasedEntityTrainedModelApiModel | null> {
    const encodedEntityId = encodeURIComponent(entityId);
    const encodedModelId = encodeURIComponent(modelId);
    const res = await this.request(`/api/model-based-entities/${encodedEntityId}/training/models/${encodedModelId}/activate`, {
      method: "POST",
    });
    return this.jsonOrNull<ActivateTrainedModelResponse | ModelBasedEntityTrainedModelApiModel>(res);
  }

  async getEntityVersion(
    entityId: string,
    versionId: string
  ): Promise<ModelBasedEntityVersionApiModel> {
    const encodedEntityId = encodeURIComponent(entityId);
    const encodedVersionId = encodeURIComponent(versionId);
    return this.json(`/api/model-based-entities/${encodedEntityId}/versions/${encodedVersionId}`);
  }

  async getEntityFileAnnotations(
    entityId: string,
    versionId: string,
    fileId: string,
    forcePredictions?: boolean
  ): Promise<ModelBasedEntityFileVersionRecordWithAnnotations> {
    const encodedEntityId = encodeURIComponent(entityId);
    const encodedVersionId = encodeURIComponent(versionId);
    const encodedFileId = encodeURIComponent(fileId);
    const query = forcePredictions === undefined
      ? ""
      : `?forcePredictions=${forcePredictions ? "true" : "false"}`;
    return this.json(
      `/api/model-based-entities/${encodedEntityId}/versions/${encodedVersionId}/files/${encodedFileId}${query}`,
      {}
    );
  }

  async activateEntityForDataset(
    entityId: string,
    datasetId: string
  ): Promise<ActivateEntityForDatasetResponse | ModelBasedEntityApiModel | null> {
    const encodedEntityId = encodeURIComponent(entityId);
    const encodedDatasetId = encodeURIComponent(datasetId);
    const res = await this.request(`/api/model-based-entities/${encodedEntityId}/datasets/${encodedDatasetId}`, {
      method: "POST",
    });
    return this.jsonOrNull<ActivateEntityForDatasetResponse | ModelBasedEntityApiModel>(res);
  }

  async deactivateEntityForDataset(
    entityId: string,
    datasetId: string
  ): Promise<DeactivateEntityForDatasetResponse | ModelBasedEntityApiModel | null> {
    const encodedEntityId = encodeURIComponent(entityId);
    const encodedDatasetId = encodeURIComponent(datasetId);
    const res = await this.request(`/api/model-based-entities/${encodedEntityId}/datasets/${encodedDatasetId}`, {
      method: "DELETE",
    });
    return this.jsonOrNull<DeactivateEntityForDatasetResponse | ModelBasedEntityApiModel>(res);
  }
}
