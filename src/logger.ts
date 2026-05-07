import fs from "node:fs";
import path from "node:path";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ARG_LENGTH = 1000; // Truncate long string args in logs

interface LogEntry {
  timestamp: string;
  level: string;
  event: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  durationMs?: number;
  error?: string;
  [key: string]: unknown;
}

function truncateArgs(args: Record<string, unknown>): Record<string, unknown> {
  const truncated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > MAX_ARG_LENGTH) {
      truncated[key] = value.slice(0, MAX_ARG_LENGTH) + `... (${value.length} chars)`;
    } else if (Array.isArray(value)) {
      truncated[key] = `[Array(${value.length})]`;
    } else {
      truncated[key] = value;
    }
  }
  return truncated;
}

function getDateString(): string {
  const now = new Date();
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

export class Logger {
  private logDir: string;
  private consoleStream: NodeJS.WriteStream;
  private currentDate: string = "";
  private currentSeq: number = 0;
  private currentStream: fs.WriteStream | null = null;
  private currentFilePath: string = "";
  private currentSize: number = 0;

  constructor(logDir?: string) {
    this.logDir = logDir || process.env.TONIC_TEXTUAL_LOG_DIR || "./logs";
    this.consoleStream = process.stdout;
    fs.mkdirSync(this.logDir, { recursive: true });
    this.openStream();
  }

  private getLogFilePath(date: string, seq: number): string {
    const base = `tonic-textual-mcp-${date}`;
    if (seq === 0) return path.join(this.logDir, `${base}.log`);
    return path.join(this.logDir, `${base}.${seq}.log`);
  }

  private openStream(): void {
    const date = getDateString();

    if (date !== this.currentDate) {
      this.currentDate = date;
      this.currentSeq = 0;
      // Find the latest sequence number for today
      while (fs.existsSync(this.getLogFilePath(date, this.currentSeq + 1))) {
        this.currentSeq++;
      }
      // Check if the current file is already over the limit
      const candidate = this.getLogFilePath(date, this.currentSeq);
      if (fs.existsSync(candidate)) {
        const stat = fs.statSync(candidate);
        if (stat.size >= MAX_FILE_SIZE) {
          this.currentSeq++;
        } else {
          this.currentSize = stat.size;
        }
      } else {
        this.currentSize = 0;
      }
    }

    const filePath = this.getLogFilePath(this.currentDate, this.currentSeq);
    if (filePath !== this.currentFilePath) {
      this.currentStream?.end();
      this.currentFilePath = filePath;
      this.currentStream = fs.createWriteStream(filePath, { flags: "a" });
    }
  }

  private rotate(): void {
    this.currentSeq++;
    this.currentSize = 0;
    const filePath = this.getLogFilePath(this.currentDate, this.currentSeq);
    this.currentStream?.end();
    this.currentFilePath = filePath;
    this.currentStream = fs.createWriteStream(filePath, { flags: "a" });
  }

  private write(entry: LogEntry): void {
    const line = JSON.stringify(entry) + "\n";
    const bytes = Buffer.byteLength(line);

    // Check for date rotation
    const today = getDateString();
    if (today !== this.currentDate) {
      this.currentDate = today;
      this.currentSeq = 0;
      this.currentSize = 0;
      const filePath = this.getLogFilePath(this.currentDate, this.currentSeq);
      this.currentStream?.end();
      this.currentFilePath = filePath;
      this.currentStream = fs.createWriteStream(filePath, { flags: "a" });
    }

    // Check for size rotation
    if (this.currentSize + bytes > MAX_FILE_SIZE) {
      this.rotate();
    }

    this.currentStream!.write(line);
    this.currentSize += bytes;

    this.consoleStream.write(line);
  }

  logToolCall(tool: string, args: Record<string, unknown>): void {
    this.write({
      timestamp: new Date().toISOString(),
      level: "info",
      event: "tool_call",
      tool,
      arguments: truncateArgs(args),
    });
  }

  logToolResult(tool: string, durationMs: number, success: boolean, error?: string): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: success ? "info" : "error",
      event: "tool_result",
      tool,
      durationMs,
    };
    if (error) entry.error = error;
    this.write(entry);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.write({
      timestamp: new Date().toISOString(),
      level: "info",
      event: "message",
      message,
      ...extra,
    });
  }

  error(message: string, extra?: Record<string, unknown>): void {
    this.write({
      timestamp: new Date().toISOString(),
      level: "error",
      event: "message",
      message,
      ...extra,
    });
  }

  close(): void {
    this.currentStream?.end();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withLogging<TArgs extends Record<string, unknown>, TResult>(
  logger: Logger,
  toolName: string,
  handler: (args: TArgs, extra: any) => Promise<TResult>
): (args: TArgs, extra: any) => Promise<TResult> {
  return async (args: TArgs, extra: any) => {
    const start = Date.now();
    logger.logToolCall(toolName, args as Record<string, unknown>);
    try {
      const result = await handler(args, extra);
      logger.logToolResult(toolName, Date.now() - start, true);
      return result;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        logger.logToolResult(toolName, Date.now() - start, false, "cancelled");
        return {
          content: [{ type: "text" as const, text: "Operation cancelled." }],
          isError: true,
        } as TResult;
      }
      let msg = err instanceof Error ? err.message : String(err);
      // Surface undici fetch's underlying cause (TLS, DNS, ECONNREFUSED, ...)
      // when present, so the tool-result log isn't a useless "fetch failed".
      const cause = (err as { cause?: unknown })?.cause;
      if (cause) {
        const causeMsg = cause instanceof Error ? cause.message : String(cause);
        const causeCode = (cause as NodeJS.ErrnoException)?.code;
        const detail = causeCode ? `${causeCode}: ${causeMsg}` : causeMsg;
        if (!msg.includes(causeMsg)) msg = `${msg} (${detail})`;
      }
      const statusCode = (err as any)?.statusCode;
      const endpoint = (err as any)?.endpoint;
      logger.logToolResult(toolName, Date.now() - start, false, msg);
      // 401/403 from Solar means the per-session API key was rejected. Surface a
      // clear, action-oriented message to the MCP client without leaking the raw
      // upstream body; the full detail is already in the server-side log above.
      if (statusCode === 401 || statusCode === 403) {
        return {
          content: [{
            type: "text" as const,
            text:
              "Authentication to Tonic Textual failed. Verify the Authorization header configured in your MCP client points to a valid, non-revoked API key for this server.",
          }],
          isError: true,
        } as TResult;
      }
      const parts = [`Error: ${msg}`];
      if (statusCode) parts.push(`Status: ${statusCode}`);
      if (endpoint) parts.push(`Endpoint: ${endpoint}`);
      parts.push("Please relay this error message to the user.");
      return {
        content: [{ type: "text" as const, text: parts.join("\n") }],
        isError: true,
      } as TResult;
    }
  };
}
