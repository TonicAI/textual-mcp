# Tonic Textual MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that connects AI assistants to [Tonic Textual](https://www.tonic.ai/textual) for PII detection and de-identification. It allows Claude and other MCP-compatible clients to redact sensitive data from text, files, and entire directories.

## Prerequisites

- **Node.js** >= 18.0.0
- A **Tonic Textual** instance (cloud or self-hosted)
- A **Tonic Textual API key** ([how to create one](https://docs.tonic.ai/textual))

## Installation

### From npm

```bash
npm install -g @tonicai/textual-mcp
```

### From source

```bash
git clone https://github.com/TonicAI/textual-mcp.git
cd textual-mcp
npm install
npm run build
```

## Configuration

All options are configured via environment variables.

| Variable | Required | Default | Description |
|---|---|---|---|
| `TONIC_TEXTUAL_API_KEY` | Yes | — | Your Tonic Textual API key |
| `TONIC_TEXTUAL_BASE_URL` | No | `https://textual.tonic.ai` | Base URL of your Textual instance |
| `TONIC_TEXTUAL_TRANSPORT` | No | `http` | Transport mode: `http` or `stdio` |
| `PORT` | No | `3000` | HTTP port (ignored in stdio mode) |
| `TONIC_TEXTUAL_MAX_CONCURRENT_REQUESTS` | No | `50` | Max concurrent requests to the Textual API |

Run `textual-mcp --help` to print all options with their descriptions and defaults.

## Running the server

`TONIC_TEXTUAL_API_KEY` is **required**. For a self-hosted Textual instance, also set `TONIC_TEXTUAL_BASE_URL`.

The server supports two transport modes controlled by `TONIC_TEXTUAL_TRANSPORT`:

- [**`http`**](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) (default) — starts an HTTP server; clients connect via URL
- [**`stdio`**](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#stdio) — reads/writes MCP JSON-RPC on stdin/stdout; the client manages the process lifecycle

### HTTP mode

```bash
# Global install
TONIC_TEXTUAL_API_KEY=your-key textual-mcp

# Self-hosted instance
TONIC_TEXTUAL_API_KEY=your-key TONIC_TEXTUAL_BASE_URL=https://your-instance.example.com textual-mcp
```

The server starts on `http://localhost:3000/mcp` by default. A health check endpoint is available at `http://localhost:3000/health`.

### stdio mode

```bash
TONIC_TEXTUAL_API_KEY=your-key TONIC_TEXTUAL_TRANSPORT=stdio textual-mcp
```

In stdio mode logs are written to `stderr` (and the log file) so they don't interfere with the MCP wire protocol on `stdout`.

## Adding to Claude

Both Claude Code and Claude Desktop use **stdio transport**, where the client starts and manages the server process automatically.

### Claude Code

```bash
claude mcp add --transport stdio textual-mcp -- env TONIC_TEXTUAL_API_KEY=your-key TONIC_TEXTUAL_TRANSPORT=stdio textual-mcp
```

### Claude Desktop

Add the following to your Claude Desktop config file (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "textual-mcp": {
      "command": "textual-mcp",
      "env": {
        "TONIC_TEXTUAL_API_KEY": "your-key",
        "TONIC_TEXTUAL_TRANSPORT": "stdio"
      }
    }
  }
}
```

For a self-hosted Textual instance, add `"TONIC_TEXTUAL_BASE_URL": "https://your-instance.example.com"` to `env`.

## Available tools

### Text redaction

| Tool | Description |
|---|---|
| `redact_text` | Redact PII from a plain text string |
| `redact_bulk` | Redact PII from multiple text strings in one call |
| `redact_json` | Redact PII from a JSON string, preserving structure |
| `redact_xml` | Redact PII from an XML string, preserving structure |
| `redact_html` | Redact PII from an HTML string, preserving structure |

All text redaction tools support:
- `generatorConfig` — per-entity-type handling (e.g. `{"NAME_GIVEN": "Synthesis", "US_SSN": "Redaction"}`)
- `generatorDefault` — default handling: `Redaction`, `Synthesis`, `Off`, `GroupingSynthesis`, or `ReplacementSynthesis`
- `generatorMetadata` — per-entity-type synthesis configuration (generator version, custom generators, deterministic swaps)
- `customEntities` — custom PII entity identifiers for detection
- `labelBlockLists` — regex/string patterns to exclude from detection per entity type
- `labelAllowLists` — regex/string patterns to force-detect per entity type

### File redaction

| Tool | Description |
|---|---|
| `redact_file` | Redact PII from a binary file (PDF, docx, xlsx, images). Uploads, polls for completion, and saves the redacted version. |

### Directory redaction

| Tool | Description |
|---|---|
| `scan_directory` | Preview a directory tree before redaction (file types, sizes, counts) |
| `deidentify_folder` | Redact an entire directory tree, preserving folder structure. Optionally redacts folder and file names. |

### Dataset management

| Tool | Description |
|---|---|
| `create_dataset` | Create a new Textual dataset |
| `list_datasets` | List all datasets |
| `get_dataset` | Get dataset details including files and processing status |
| `upload_file_to_dataset` | Upload a file to a dataset |
| `download_dataset_file` | Download a redacted file from a dataset |

### Job monitoring

| Tool | Description |
|---|---|
| `list_file_jobs` | List all unattached file redaction jobs with statuses |
| `get_file_job` | Get status of a specific file redaction job |
| `get_job_error_logs` | Download error logs for a failed job |

### Reference

| Tool | Description |
|---|---|
| `list_pii_types` | List all PII entity types that Textual can detect |

## Examples

### Redact text

Ask Claude:

> "Redact the PII from this text: John Smith lives at 123 Main St and his SSN is 456-78-9012"

### Redact a PDF

> "Redact all PII from /path/to/document.pdf and save it to /path/to/output.pdf"

### Redact with synthesis

> "Redact this text using synthesis for names and redaction for SSNs: John Smith's SSN is 456-78-9012"

Claude will call `redact_text` with `generatorConfig: {"NAME_GIVEN": "Synthesis", "NAME_FAMILY": "Synthesis", "US_SSN": "Redaction"}`.

### De-identify a folder

> "Scan /path/to/documents first, then de-identify the whole folder to /path/to/output, skipping any .log files"

### Check job status

> "List all file redaction jobs from the last hour"

## Development

```bash
npm install
npm run dev     # watch mode — recompiles on changes
npm run build   # one-time build
npm start       # run the server
```

## License

MIT
