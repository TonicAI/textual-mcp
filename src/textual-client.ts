import fs from "node:fs";
import path from "node:path";
import { lookup } from "mime-types";
import type { Logger } from "./logger.js";

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

export interface FileRedactionJob {
  jobId: string;
  fileName: string;
}

export interface FileJob {
  id: string;
  status: string;
  errorMessages: string | null;
  startTime: string | null;
  endTime: string | null;
  publishedTime: string;
  jobType: string;
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

  private async request(
    endpoint: string,
    options: RequestInit = {},
    signal?: AbortSignal
  ): Promise<Response> {
    const url = `${this.baseUrl}${endpoint}`;
    const method = options.method || "GET";
    const headers: Record<string, string> = {
      Authorization: this.apiKey,
      ...((options.headers as Record<string, string>) || {}),
    };
    await this.semaphore.acquire();
    const start = Date.now();
    this.logger?.info("api_request_start", { method, endpoint, inflight: this.semaphore.inflight, pending: this.semaphore.pending });
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

  async startFileRedaction(filePath: string, signal?: AbortSignal): Promise<FileRedactionJob> {
    const fileName = path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);
    const mimeType = lookup(filePath) || "application/octet-stream";

    const formData = new FormData();
    formData.append(
      "document",
      new Blob(
        [JSON.stringify({
          fileName,
          csvConfig: {},
          datasetId: "",
          customPiiEntityIds: [],
        })],
        { type: "application/json" }
      )
    );
    formData.append("file", new Blob([fileBuffer], { type: mimeType }), fileName);

    const res = await this.request("/api/unattachedfile/upload", {
      method: "POST",
      body: formData,
    }, signal);
    const data = await res.json();
    return { jobId: data.jobId ?? data.id, fileName };
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

  async uploadFileToDataset(datasetId: string, filePath: string): Promise<DatasetFile> {
    const fileName = path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);
    const mimeType = lookup(filePath) || "application/octet-stream";

    const formData = new FormData();
    formData.append("file", new Blob([fileBuffer], { type: mimeType }), fileName);

    const res = await this.request(`/api/Dataset/${datasetId}/files/upload`, {
      method: "POST",
      body: formData,
    });
    return res.json() as Promise<DatasetFile>;
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
}
