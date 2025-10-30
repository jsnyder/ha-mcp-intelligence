/**
 * ToolRegistry - Registry of tools available to the agent
 */

import type { ToolSpec, ToolInvokeContext } from './types.js';

export class ToolRegistry {
  private tools = new Map<string, ToolSpec>();

  /**
   * Register a tool
   */
  register(tool: ToolSpec): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool ${tool.name} is already registered`);
    }

    this.tools.set(tool.name, tool);
  }

  /**
   * Unregister a tool
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Get a tool by name
   */
  getTool(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  /**
   * List all tool names
   */
  listToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get all tools
   */
  getAllTools(): ToolSpec[] {
    return Array.from(this.tools.values());
  }

  /**
   * Invoke a tool
   */
  async invoke(name: string, args: unknown, ctx: ToolInvokeContext): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool ${name} not found`);
    }

    // Check actuation safety
    if (tool.safety?.requiresActuation && !ctx.session.policy.allowActuation) {
      throw new Error(`Tool ${name} requires actuation but session policy disallows it`);
    }

    // Log tool call
    ctx.logger({
      ts: Date.now(),
      type: 'tool_call',
      detail: { tool: name, args },
    });

    try {
      const result = await tool.invoke(args, ctx);

      // Log result
      ctx.logger({
        ts: Date.now(),
        type: 'tool_result',
        detail: { tool: name, success: true, result },
      });

      return result;
    } catch (err) {
      // Log error
      ctx.logger({
        ts: Date.now(),
        type: 'error',
        detail: { tool: name, error: (err as Error).message },
      });

      throw err;
    }
  }

  /**
   * Get tool catalog for LLM prompt
   */
  getToolCatalog(): Array<{ name: string; description: string; inputSchema: object }> {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  /**
   * Check if tool is safe (doesn't require actuation)
   */
  isSafeTool(name: string): boolean {
    const tool = this.tools.get(name);
    if (!tool) {
      return false;
    }

    return !tool.safety?.requiresActuation;
  }
}
