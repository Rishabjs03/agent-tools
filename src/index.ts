/**
 * @anthropic-agents/agent-tools
 *
 * A typed, extensible tool framework for AI agents.
 * Define tools with Zod schemas, permission checking, concurrent execution,
 * progress reporting, and lifecycle hooks.
 *
 * Extracted from a production AI coding agent with 40+ tools.
 */

import { z, type ZodType, type ZodObject, type ZodRawShape } from "zod";

// ─── Core Types ──────────────────────────────────────────────────────

export type ToolInput = ZodObject<ZodRawShape>;

export interface ToolResult<T = unknown> {
  data: T;
  /** Optional new messages to inject into the conversation */
  newMessages?: Array<{ role: string; content: string }>;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

export interface ToolProgress {
  toolUseId: string;
  type: string;
  message?: string;
  percentage?: number;
  data?: Record<string, unknown>;
}

export type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string }
  | { behavior: "ask"; message: string };

export interface ToolContext {
  /** Current working directory */
  cwd: string;
  /** Abort signal for cancellation */
  signal: AbortSignal;
  /** Tool permission rules */
  permissions?: ToolPermissionRules;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

export interface ToolPermissionRules {
  alwaysAllow?: string[];
  alwaysDeny?: string[];
  alwaysAsk?: string[];
}

export interface ToolCallProgress<P = ToolProgress> {
  (progress: P): void;
}

// ─── Tool Definition ──────────────────────────────────────────────

export interface ToolDefinition<
  Input extends ToolInput = ToolInput,
  Output = unknown,
> {
  /** Unique tool name */
  name: string;
  /** Optional aliases for backwards compatibility */
  aliases?: string[];
  /** Tool description for the LLM */
  description: string;
  /** Zod schema for validating input */
  inputSchema: Input;
  /** Short search hint for tool discovery */
  searchHint?: string;

  /** Execute the tool */
  call(
    args: z.infer<Input>,
    context: ToolContext,
    onProgress?: ToolCallProgress
  ): Promise<ToolResult<Output>>;

  /** Check if input is valid (beyond schema validation) */
  validateInput?(
    input: z.infer<Input>,
    context: ToolContext
  ): Promise<{ valid: true } | { valid: false; message: string }>;

  /** Check permissions for this tool call */
  checkPermissions?(
    input: z.infer<Input>,
    context: ToolContext
  ): Promise<PermissionResult>;

  /** Whether this tool is safe to run concurrently with other tools */
  isConcurrencySafe?(input: z.infer<Input>): boolean;
  /** Whether this tool only reads data (no side effects) */
  isReadOnly?(input: z.infer<Input>): boolean;
  /** Whether this tool is enabled */
  isEnabled?(): boolean;
  /** Max result size before truncation (chars) */
  maxResultSizeChars?: number;
}

// ─── Built Tool (with defaults applied) ──────────────────────────

export interface Tool<
  Input extends ToolInput = ToolInput,
  Output = unknown,
> {
  name: string;
  aliases: string[];
  description: string;
  inputSchema: Input;
  searchHint?: string;
  call(
    args: z.infer<Input>,
    context: ToolContext,
    onProgress?: ToolCallProgress
  ): Promise<ToolResult<Output>>;
  validateInput(
    input: z.infer<Input>,
    context: ToolContext
  ): Promise<{ valid: true } | { valid: false; message: string }>;
  checkPermissions(
    input: z.infer<Input>,
    context: ToolContext
  ): Promise<PermissionResult>;
  isConcurrencySafe(input: z.infer<Input>): boolean;
  isReadOnly(input: z.infer<Input>): boolean;
  isEnabled(): boolean;
  maxResultSizeChars: number;
}

// ─── buildTool Factory ───────────────────────────────────────────

const DEFAULTS = {
  aliases: [] as string[],
  isEnabled: () => true,
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  validateInput: async () => ({ valid: true as const }),
  checkPermissions: async (
    input: Record<string, unknown>
  ): Promise<PermissionResult> => ({
    behavior: "allow",
    updatedInput: input,
  }),
  maxResultSizeChars: 100_000,
};

/**
 * Build a complete Tool from a partial definition, filling in safe defaults.
 * All tool exports should go through this so defaults live in one place.
 *
 * @example
 * ```ts
 * const readFile = buildTool({
 *   name: 'read_file',
 *   description: 'Read a file from the filesystem',
 *   inputSchema: z.object({ path: z.string(), lines: z.number().optional() }),
 *   async call(args, ctx) {
 *     const content = await fs.readFile(args.path, 'utf-8');
 *     return { data: content };
 *   },
 *   isReadOnly: () => true,
 *   isConcurrencySafe: () => true,
 * });
 * ```
 */
export function buildTool<
  Input extends ToolInput,
  Output,
>(def: ToolDefinition<Input, Output>): Tool<Input, Output> {
  return {
    ...DEFAULTS,
    ...def,
    aliases: def.aliases ?? DEFAULTS.aliases,
  } as Tool<Input, Output>;
}

// ─── Tool Matching ───────────────────────────────────────────────

export function toolMatchesName(
  tool: { name: string; aliases?: string[] },
  name: string
): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false);
}

export function findToolByName<T extends { name: string; aliases?: string[] }>(
  tools: readonly T[],
  name: string
): T | undefined {
  return tools.find((t) => toolMatchesName(t, name));
}

// ─── Tool Executor ───────────────────────────────────────────────

export interface ToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolExecutionResult {
  toolUseId: string;
  toolName: string;
  result: ToolResult | null;
  error?: string;
  durationMs: number;
  wasPermissionDenied?: boolean;
}

/**
 * Execute a set of tool calls, respecting concurrency safety.
 * Read-only and concurrency-safe tools run in parallel;
 * others run sequentially.
 */
export async function executeTools(
  toolUses: ToolUseBlock[],
  tools: readonly Tool[],
  context: ToolContext,
  options?: {
    onProgress?: ToolCallProgress;
    onResult?: (result: ToolExecutionResult) => void;
    permissionChecker?: (
      tool: Tool,
      input: Record<string, unknown>
    ) => Promise<PermissionResult>;
  }
): Promise<ToolExecutionResult[]> {
  const results: ToolExecutionResult[] = [];

  // Separate concurrent-safe and sequential tools
  const concurrent: ToolUseBlock[] = [];
  const sequential: ToolUseBlock[] = [];

  for (const use of toolUses) {
    const tool = findToolByName(tools, use.name);
    if (!tool) {
      results.push({
        toolUseId: use.id,
        toolName: use.name,
        result: null,
        error: `Unknown tool: ${use.name}`,
        durationMs: 0,
      });
      continue;
    }

    if (tool.isConcurrencySafe(use.input)) {
      concurrent.push(use);
    } else {
      sequential.push(use);
    }
  }

  // Run concurrent tools in parallel
  const concurrentResults = await Promise.all(
    concurrent.map((use) =>
      executeSingleTool(use, tools, context, options)
    )
  );
  for (const r of concurrentResults) {
    results.push(r);
    options?.onResult?.(r);
  }

  // Run sequential tools one at a time
  for (const use of sequential) {
    if (context.signal.aborted) break;
    const r = await executeSingleTool(use, tools, context, options);
    results.push(r);
    options?.onResult?.(r);
  }

  return results;
}

async function executeSingleTool(
  use: ToolUseBlock,
  tools: readonly Tool[],
  context: ToolContext,
  options?: {
    onProgress?: ToolCallProgress;
    permissionChecker?: (
      tool: Tool,
      input: Record<string, unknown>
    ) => Promise<PermissionResult>;
  }
): Promise<ToolExecutionResult> {
  const start = Date.now();
  const tool = findToolByName(tools, use.name);

  if (!tool) {
    return {
      toolUseId: use.id,
      toolName: use.name,
      result: null,
      error: `Unknown tool: ${use.name}`,
      durationMs: Date.now() - start,
    };
  }

  if (!tool.isEnabled()) {
    return {
      toolUseId: use.id,
      toolName: use.name,
      result: null,
      error: `Tool "${use.name}" is disabled`,
      durationMs: Date.now() - start,
    };
  }

  // Validate input
  const parseResult = tool.inputSchema.safeParse(use.input);
  if (!parseResult.success) {
    return {
      toolUseId: use.id,
      toolName: use.name,
      result: null,
      error: `Invalid input: ${parseResult.error.message}`,
      durationMs: Date.now() - start,
    };
  }

  // Check custom validation
  const validation = await tool.validateInput(parseResult.data, context);
  if (!validation.valid) {
    return {
      toolUseId: use.id,
      toolName: use.name,
      result: null,
      error: validation.message,
      durationMs: Date.now() - start,
    };
  }

  // Check permissions
  const checker = options?.permissionChecker ?? tool.checkPermissions.bind(tool);
  const permission = await checker(tool, parseResult.data);
  if (permission.behavior === "deny") {
    return {
      toolUseId: use.id,
      toolName: use.name,
      result: null,
      error: permission.message,
      durationMs: Date.now() - start,
      wasPermissionDenied: true,
    };
  }

  try {
    const result = await tool.call(parseResult.data, context, options?.onProgress);
    return {
      toolUseId: use.id,
      toolName: use.name,
      result,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      toolUseId: use.id,
      toolName: use.name,
      result: null,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

// ─── Pre-built Tool Search ───────────────────────────────────────

/**
 * Search for tools by keyword matching against name, description, and searchHint.
 */
export function searchTools(
  tools: readonly Tool[],
  query: string,
  maxResults = 10
): Tool[] {
  const queryLower = query.toLowerCase();
  const scored = tools
    .filter((t) => t.isEnabled())
    .map((tool) => {
      let score = 0;
      const name = tool.name.toLowerCase();
      const desc = tool.description.toLowerCase();
      const hint = tool.searchHint?.toLowerCase() ?? "";

      if (name.includes(queryLower)) score += 10;
      if (hint.includes(queryLower)) score += 5;
      if (desc.includes(queryLower)) score += 3;

      // Partial word matching
      for (const word of queryLower.split(/\s+/)) {
        if (name.includes(word)) score += 2;
        if (hint.includes(word)) score += 1;
        if (desc.includes(word)) score += 1;
      }

      return { tool, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, maxResults).map(({ tool }) => tool);
}

// ─── Hook System ─────────────────────────────────────────────────

export interface PreToolHook {
  name: string;
  /** Return false to prevent tool execution */
  execute(
    toolName: string,
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<boolean>;
}

export interface PostToolHook {
  name: string;
  execute(
    toolName: string,
    input: Record<string, unknown>,
    result: ToolResult,
    context: ToolContext
  ): Promise<void>;
}

export class HookRegistry {
  private preHooks: PreToolHook[] = [];
  private postHooks: PostToolHook[] = [];

  registerPreHook(hook: PreToolHook): void {
    this.preHooks.push(hook);
  }

  registerPostHook(hook: PostToolHook): void {
    this.postHooks.push(hook);
  }

  async runPreHooks(
    toolName: string,
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<boolean> {
    for (const hook of this.preHooks) {
      const allowed = await hook.execute(toolName, input, context);
      if (!allowed) return false;
    }
    return true;
  }

  async runPostHooks(
    toolName: string,
    input: Record<string, unknown>,
    result: ToolResult,
    context: ToolContext
  ): Promise<void> {
    for (const hook of this.postHooks) {
      await hook.execute(toolName, input, result, context);
    }
  }
}

// Re-export zod for convenience
export { z };
