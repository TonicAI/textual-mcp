# Tonic Textual MCP Server

[![npm version](https://img.shields.io/npm/v/@tonicai/textual-mcp)](https://www.npmjs.com/package/@tonicai/textual-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that connects AI assistants to [Tonic Textual](https://www.tonic.ai/textual) for PII detection, de-identification, and model-based entity training. It allows Claude and other MCP-compatible clients to redact sensitive data and to drive the full model-based-entity workflow end-to-end.

**Key capabilities:**

- **Text redaction** — Redact plain text, JSON, XML, and HTML with structure preservation
- **File redaction** — Process PDFs, Word docs, spreadsheets, and images while keeping original formatting
- **Directory redaction** — De-identify entire folder trees in a single call with automatic file type routing
- **Dataset management** — Create, upload to, and download from Textual datasets
- **Model-based entities** — Create custom entities, upload test/training files, review LLM annotations, save ground truth, train and activate models, and activate them on datasets
- **Multi-tenant by design** — Per-MCP-client API key passthrough; concurrent users are fully isolated
- **Fine-grained control** — Per-entity redaction/synthesis config, deterministic replacements, allow/block lists, custom entity models, and 35+ built-in entity types across 50+ languages

## Prerequisites

- **Node.js** >= 18.0.0
- A **Tonic Textual** instance (cloud or self-hosted)
- A **Tonic Textual API key** for each end-user — passed at connect time as the `Authorization` header (see [Authentication](#authentication))

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

The server is configured via environment variables. **No API key is configured at the server level** — credentials are supplied per MCP client session via the `Authorization` header.

| Variable | Required | Default | Description |
|---|---|---|---|
| `TONIC_TEXTUAL_BASE_URL` | No | `https://textual.tonic.ai` | Base URL of your Textual instance |
| `PORT` | No | `3000` | HTTP port for the MCP server |
| `TONIC_TEXTUAL_ALLOW_LOCAL_FILES` | No | unset | When set (`true`/`1`/`yes`/`on`), enables [local-install mode](#deployment-modes): exposes filesystem-orchestration tools and adds optional `filePath`/`outputPath` arguments on file tools |
| `TONIC_TEXTUAL_MAX_CONCURRENT_REQUESTS` | No | `50` | Max concurrent requests to the Textual API per session |
| `TONIC_TEXTUAL_POLL_TIMEOUT_SECONDS` | No | `900` | Timeout (in seconds) for polling file processing jobs |
| `TONIC_TEXTUAL_SESSION_IDLE_TIMEOUT_MS` | No | `1800000` (30 min) | Idle session eviction window |
| `TONIC_TEXTUAL_LOG_DIR` | No | `./logs` | Directory for structured log files |

## Deployment modes

The server supports two operating modes that share one binary and one codebase.

### Hosted mode (default)

The server runs alongside your Textual instance and **never touches the caller's filesystem**. All file uploads go in as base64 inline; all downloads come back as base64 inline. This is the right mode for a centrally-deployed MCP server that multiple users connect to from their own machines.

```bash
# Tonic Textual cloud
TONIC_TEXTUAL_BASE_URL=https://textual.tonic.ai textual-mcp

# Self-hosted Textual
TONIC_TEXTUAL_BASE_URL=https://textual.your-company.example.com textual-mcp
```

In hosted mode the `scan_directory` and `deidentify_folder` tools are **not registered** (the server has no folder to scan), and the `filePath`/`outputPath` arguments are **not exposed** on file tools.

### Local-install mode

Set `TONIC_TEXTUAL_ALLOW_LOCAL_FILES=true` to grant the server read/write access to the caller's local filesystem. Use this when you `npm install -g @tonicai/textual-mcp` next to Claude Desktop on a developer's machine.

```bash
TONIC_TEXTUAL_ALLOW_LOCAL_FILES=true textual-mcp
```

In local-install mode `scan_directory` and `deidentify_folder` are registered, and the file tools accept an optional `filePath` (uploads) or `outputPath` (downloads) as an alternative to inline base64.

The server starts on `http://localhost:3000` by default. A health check is at `/health`.

## Authentication

Each MCP client supplies its own Tonic Textual API key via the `Authorization` header on the MCP session-initialization request. The server binds the key to that session for its lifetime; concurrent sessions with different keys are fully isolated.

```http
POST /mcp
Authorization: <your-tonic-textual-api-key>
```

`Bearer <key>` is also accepted. A request that arrives without a usable `Authorization` header is rejected with HTTP 401 + JSON-RPC `-32001`. If the upstream Textual API rejects the key (401/403), the MCP response is `{ isError: true, content: "Authentication to Tonic Textual failed..." }` — no upstream body is leaked back through the MCP channel.

To mint an API key, sign in to your Tonic Textual instance and create one from the API Keys section in your user settings.

## Tool profiles

Two endpoints are exposed; pick one in your MCP client config based on what your assistant needs.

| Endpoint | Profile | Use when |
|---|---|---|
| `/mcp` | **Full** (default) | You want the complete tool surface — general PII redaction, file/dataset operations, and the model-based-entity workflow |
| `/mcp/light` | **Light** | You only need the model-based-entity workflow (entity CRUD, versioning, test/training files, trained models, activation, plus a few supporting tools). General-purpose redaction tools are omitted to keep the surface focused. |

The profile is recorded on the session at initialize time and surfaced in server-side logs.

## Adding to Claude

> **Note:** Start the MCP server before adding it to your Claude client. See [Deployment modes](#deployment-modes) above. Replace `your-tonic-textual-api-key` with your actual key.

### Claude Code

```bash
# Full profile
claude mcp add --transport http textual-mcp http://localhost:3000/mcp \
  --header "Authorization: your-tonic-textual-api-key"

# Light profile (model-based entities only)
claude mcp add --transport http textual-mcp-light http://localhost:3000/mcp/light \
  --header "Authorization: your-tonic-textual-api-key"
```

### Claude Desktop

Add the following to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "textual-mcp": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "your-tonic-textual-api-key"
      }
    }
  }
}
```

For the light profile use `"url": "http://localhost:3000/mcp/light"`.

### Cursor

```json
{
  "mcpServers": {
    "textual-mcp": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "your-tonic-textual-api-key"
      }
    }
  }
}
```

## Available tools

### Light profile (`/mcp/light`)

The light profile is curated for the model-based-entity workflow and includes the supporting tools needed to drive it end-to-end.

#### Model-based entities

| Tool | Description |
|---|---|
| `create_model_based_entity` | Create a new model-based entity with initial guidelines |
| `list_model_based_entities` | List active model-based entities |
| `list_all_model_based_entities` | Paginated listing with search and user/status filters |
| `get_model_based_entity` | Get an entity's current lifecycle status and details |
| `update_model_based_entity` | Update an entity's fields |
| `delete_model_based_entity` | Delete an entity |
| `get_supported_entity_file_types` | List MIME types accepted for entity test/training files |

#### Versioning, annotations, and ground truth

| Tool | Description |
|---|---|
| `create_entity_version` | Create a new entity version with updated guidelines |
| `get_entity_version` | Get a version's status, guidelines, metrics, and per-file summaries |
| `list_entity_versions` | List versions for an entity with status and metrics |
| `get_suggested_guidelines` | Retrieve LLM-suggested guideline refinements for a version |
| `retry_version_annotation` | Re-run annotation for a version |
| `retry_suggested_guidelines` | Re-run suggested-guideline generation for a version |
| `upload_entity_test_file` | Upload a test/review file (inline base64; or `filePath` in local-install mode) |
| `list_entity_test_files` | List test/review files attached to an entity |
| `delete_entity_test_file` | Remove a test/review file |
| `get_entity_file_annotations` | Get annotations for a single file in a version |
| `list_entity_file_annotations` | Get annotations for **all** files in a version in one call |
| `save_entity_ground_truth` | Save reviewed ground-truth spans for a test file (optionally mark reviewed) |

#### Trained models, training data, and activation

| Tool | Description |
|---|---|
| `upload_entity_training_file` | Upload a training file (inline base64; or `filePath` in local-install mode) |
| `list_entity_training_files` | List training files for an entity |
| `get_entity_training_file` | Get details for a training file |
| `delete_entity_training_file` | Remove a training file |
| `create_trained_model` | Create a trained-model record for an entity version |
| `list_trained_models` | List trained models for an entity |
| `get_trained_model` | Get a trained model's status |
| `list_model_training_files` | List training files attached to a specific trained model |
| `get_model_training_file` | Get one trained-model training file with annotations |
| `list_model_detected_entities` | List the most common detected entity values for a trained model |
| `start_model_training` | Start training (async) |
| `activate_trained_model` | Activate a trained model for an entity (async) |
| `activate_entity_for_dataset` | Activate the entity's active model on a dataset |
| `deactivate_entity_for_dataset` | Deactivate the entity for a dataset |

#### Supporting reference tools

| Tool | Description |
|---|---|
| `list_pii_types` | List all PII entity types Textual can detect |
| `list_datasets` | List datasets accessible to the caller |
| `get_dataset` | Get dataset details (used to pick a dataset for entity activation) |

### Full profile additions (`/mcp`)

Everything in the light profile, plus the general-purpose redaction and dataset operations below.

#### Text redaction

| Tool | Description |
|---|---|
| `redact_text` | Redact PII from a plain text string |
| `redact_bulk` | Redact PII from multiple strings in one call |
| `redact_json` | Redact PII from a JSON string, preserving structure |
| `redact_xml` | Redact PII from an XML string, preserving structure |
| `redact_html` | Redact PII from an HTML string, preserving structure |

All text redaction tools support `generatorConfig`, `generatorDefault`, `generatorMetadata`, `customEntities`, `labelBlockLists`, and `labelAllowLists`.

#### File redaction (bytes-canonical)

| Tool | Description |
|---|---|
| `redact_file` | Redact a binary file (PDF, docx, xlsx, images). Returns redacted bytes inline as base64 in the task completion payload. |
| `download_redacted_file` | Download a previously redacted file by job ID; returns base64 |
| `list_file_jobs` | List unattached file redaction jobs with statuses |
| `get_file_job` | Get status of a specific job |
| `get_job_error_logs` | Download error logs for a failed job |

#### Dataset CRUD

| Tool | Description |
|---|---|
| `create_dataset` | Create a new Textual dataset |
| `upload_file_to_dataset` | Upload a file to a dataset (inline base64) |
| `download_dataset_file` | Download a redacted file from a dataset; returns base64 |

#### Local-install only (`TONIC_TEXTUAL_ALLOW_LOCAL_FILES=true`)

| Tool | Description |
|---|---|
| `scan_directory` | Preview a local directory tree (file types, sizes, counts) |
| `deidentify_folder` | Redact an entire local directory tree, preserving folder structure |

In local-install mode the bytes-canonical file tools above also accept `filePath` (uploads) or `outputPath` (downloads) as alternatives to inline base64.

## Examples

Once the server is running and connected to your MCP client, you can interact with Textual using natural language.

### Redact text

> "Redact the PII from this text: John Smith lives at 123 Main St and his SSN is 456-78-9012"

### Redact a PDF (hosted mode)

> "Here is a base64-encoded PDF — redact all PII and return the redacted bytes."

The agent calls `redact_file` with `{ fileName, contentBase64, ... }` and reads the redacted bytes back from the task completion payload.

### Redact a PDF (local-install mode)

> "Redact all PII from /path/to/document.pdf and save it to /path/to/output.pdf"

### Redact with synthesis

> "Redact this text using synthesis for names and redaction for SSNs: John Smith's SSN is 456-78-9012"

### De-identify a folder (local-install mode only)

> "Scan /path/to/documents first, then de-identify the whole folder to /path/to/output, skipping any .log files"

### Drive a model-based entity end-to-end (light profile)

> "Create a new entity called 'project-codename' with these guidelines, upload these test files for review, show me the annotations, save the ground truth, then create a trained model and activate it on dataset X."

## Architecture

- **HTTP streaming transport** — Serves MCP over HTTP at `/mcp` (full) and `/mcp/light` (curated) with multi-session management
- **Per-session credential isolation** — Each session has its own `TextualClient` bound to the caller's API key; concurrent users never share state
- **Idle session eviction** — Sessions inactive past `TONIC_TEXTUAL_SESSION_IDLE_TIMEOUT_MS` (default 30 min) are reaped so credentials aren't retained
- **Concurrency control** — Per-session semaphore-based rate limiting prevents overwhelming the Textual API
- **Background task processing** — File redaction uses the MCP task API for non-blocking operation with status polling
- **Automatic retries** — Transient network errors (`ECONNRESET`, `ECONNREFUSED`, `EPIPE`) are retried transparently
- **Auth-failure mapping** — Upstream 401/403 is converted to a clean MCP error without leaking upstream body
- **Structured logging** — Rotating JSON log files (per-date, 10MB rotation) for observability

## Development

```bash
npm install
npm run dev     # watch mode — recompiles on changes
npm run build   # one-time build
npm start       # run the server
npm run clean   # remove compiled output
```

## Resources

- [Tonic Textual product documentation](https://docs.tonic.ai/textual)
- [Textual REST API reference](https://docs.tonic.ai/textual/textual-rest-api/about-the-textual-rest-api)
- [Textual Python SDK documentation](https://tonic-textual-sdk.readthedocs-hosted.com/en/latest/index.html)
- [Model Context Protocol specification](https://modelcontextprotocol.io/)

## License

MIT
