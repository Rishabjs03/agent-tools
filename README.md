# @rishabjs03/agent-tools

> A typed, extensible tool framework for AI agents.

Extracted from a production AI coding agent with 40+ tools. Define tools with Zod schemas, validate inputs, check permissions, execute concurrently, and extend with lifecycle hooks.

## Features

- 🔧 **Typed tool definitions** — Zod schemas for input validation
- 🏗️ **`buildTool()` factory** — safe defaults, one-line tool creation
- ⚡ **Concurrent execution** — parallel for read-only, sequential for writes
- 🔒 **Permission system** — allow/deny/ask per-tool permission checks
- 🔍 **Tool search** — keyword-based tool discovery for large tool sets
- 🪝 **Hook system** — pre/post execution hooks for audit, security, validation
- ✅ **Input validation** — schema + custom validators

## Install

```bash
npm install @rishabjs03/agent-tools
```

## Quick Start

```typescript
import { buildTool, executeTools, z } from '@rishabjs03/agent-tools';

// Define a tool
const readFile = buildTool({
  name: 'read_file',
  description: 'Read a file from the filesystem',
  inputSchema: z.object({
    path: z.string().describe('File path to read'),
    maxLines: z.number().optional().describe('Max lines to read'),
  }),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(args, ctx) {
    const fs = await import('fs/promises');
    const content = await fs.readFile(args.path, 'utf-8');
    return { data: content };
  },
});

const writeFile = buildTool({
  name: 'write_file',
  description: 'Write content to a file',
  inputSchema: z.object({
    path: z.string(),
    content: z.string(),
  }),
  isConcurrencySafe: () => false, // Not safe to run concurrently
  async call(args) {
    const fs = await import('fs/promises');
    await fs.writeFile(args.path, args.content);
    return { data: `Wrote ${args.content.length} bytes to ${args.path}` };
  },
});

// Execute tool calls from LLM response
const results = await executeTools(
  [
    { id: 'tu_1', name: 'read_file', input: { path: 'README.md' } },
    { id: 'tu_2', name: 'read_file', input: { path: 'package.json' } },
  ],
  [readFile, writeFile],
  { cwd: process.cwd(), signal: AbortSignal.timeout(30000) }
);
// Both reads execute in parallel! ⚡
```

## Hook System

Add security, auditing, or custom logic around tool execution:

```typescript
import { HookRegistry } from '@rishabjs03/agent-tools';

const hooks = new HookRegistry();

// Block dangerous commands
hooks.registerPreHook({
  name: 'security-check',
  async execute(toolName, input) {
    if (toolName === 'bash' && String(input.command).includes('rm -rf')) {
      return false; // Block execution
    }
    return true;
  },
});

// Audit all tool calls
hooks.registerPostHook({
  name: 'audit-log',
  async execute(toolName, input, result) {
    console.log(`[AUDIT] ${toolName}:`, JSON.stringify(input));
  },
});
```

## Tool Search

Find relevant tools from a large set:

```typescript
import { searchTools } from '@rishabjs03/agent-tools';

const matches = searchTools(allTools, 'file read');
// Returns tools ranked by relevance to the query
```

## License

MIT
