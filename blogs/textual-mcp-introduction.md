# Announcing the Tonic Textual MCP Server: PII Redaction Meets AI Agents

## The Challenge: Sensitive Data Is Everywhere

Every organization handles sensitive data. It lives in training datasets, test environments, customer support logs, legal contracts, medical records, and countless other places. Whether you're preparing data for model training, generating realistic test datasets, or processing documents for review, the challenge is the same: you need to find and protect personally identifiable information (PII) without destroying the usefulness of the data.

Tonic Textual already solves this problem. It detects and transforms PII across text, files, and audio in 50+ languages, with fine-grained control over how each entity type is handled — masking, synthesis, or deterministic replacement. Thousands of teams use Textual to prepare safe training corpora, generate compliant test data, and redact sensitive documents at scale.

Today, we're making Textual even more accessible: **we're releasing an open-source MCP server that brings Textual's full redaction capabilities directly into AI agent workflows.**

## What Is MCP?

The [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) is an open standard for connecting AI assistants to external tools and data sources. Think of it as a universal plug that lets AI agents take real actions — not just generate text, but call APIs, process files, and interact with the systems you already use.

MCP is supported by a growing ecosystem of clients including Claude Desktop, Cursor, Windsurf, and custom-built agents. By publishing a Textual MCP server, we're making PII redaction a first-class capability in any of these environments.

## What You Can Do With the Textual MCP Server

The server exposes 21 tools that cover the full breadth of Textual's capabilities:

### Redact Text on the Fly

Process plain text, JSON, XML, and HTML directly. Bulk mode handles multiple strings in a single call. JSON redaction supports JSONPath expressions for surgical control — specify exactly which paths to redact or leave untouched.

### Process Files With Format Preservation

Upload PDFs, Word documents, spreadsheets, and images for redaction. The original formatting is preserved — a redacted PDF still looks like a PDF, not a stripped-down text dump. File processing runs in the background so your agent isn't blocked waiting for large files to complete.

### De-identify Entire Directories in One Call

Point the `deidentify_folder` tool at a directory and it handles everything: detects file types, routes text files through the fast inline API and binary files through the upload pipeline, processes them in parallel, and writes redacted output alongside the originals. Filter by extension, skip specific patterns, and even redact folder and file names.

### Manage Datasets

Create datasets in the Textual platform, upload files for scanning, and download redacted results — all through your AI agent. This integrates Textual's dataset workflow directly into automated pipelines.

### Full Control Over Redaction Behavior

Every tool supports Textual's rich configuration options:

- **Per-entity handling** — Choose redaction, synthesis, or off for each of the 35+ supported entity types
- **Synthesis modes** — V1 or V2 (length-aware), plus specialized generators for emails, phone numbers, SSNs, credit cards, and more
- **Deterministic replacements** — Map specific PII values to consistent synthetic replacements across documents
- **Allow and block lists** — Force-detect or exclude specific values using strings or regex patterns
- **Custom entity models** — Use models trained on your proprietary data

## Example Use Cases

- **Preparing safe training data** — Redact PII from text corpora before fine-tuning or pre-training language models
- **Generating realistic test datasets** — Synthesize PII so data stays structurally useful but fully compliant
- **Building compliant RAG pipelines** — De-identify documents before they enter vector stores, so retrieved context is always clean
- **Document review workflows** — Sanitize contracts, medical records, or support tickets during AI-assisted review
- **Data pipeline automation** — Clean data exports in bulk, redact files as part of CI/CD, or process incoming data on arrival

## Getting Started

### Install

```bash
npm install -g @tonicai/textual-mcp
```

### Configure

Set your Textual API key as an environment variable:

```bash
export TONIC_TEXTUAL_API_KEY=your-api-key-here
```

For self-hosted Textual instances, also set:

```bash
export TONIC_TEXTUAL_BASE_URL=https://your-textual-instance.example.com
```

### Add to Your MCP Client

For Claude Desktop, add the server to your MCP configuration:

```json
{
  "mcpServers": {
    "textual": {
      "command": "textual-mcp",
      "env": {
        "TONIC_TEXTUAL_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

Then ask your AI assistant to redact text, process a file, or de-identify an entire folder — Textual handles the rest.

## Under the Hood

For the technically curious:

- **Built on the MCP SDK** with HTTP streaming transport, exposing a `/mcp` endpoint and a `/health` check
- **Concurrency-controlled** — a semaphore limits concurrent API calls (default 50) to avoid overwhelming the Textual API
- **Background task processing** — file uploads use the MCP task API for non-blocking operation with status polling
- **Automatic retries** — transient network errors are retried transparently
- **Structured logging** — rotating JSON log files for observability and debugging

## Try It Out

- **npm package**: [@tonicai/textual-mcp](https://www.npmjs.com/package/@tonicai/textual-mcp)
- **Product documentation**: [docs.tonic.ai/textual](https://docs.tonic.ai/textual)
- **API documentation**: [Textual REST API](https://docs.tonic.ai/textual/textual-rest-api/about-the-textual-rest-api)

We'd love your feedback. Try the server, let us know what you build with it, and open an issue if you run into anything. PII redaction should be as easy as asking your AI assistant — and now it is.
