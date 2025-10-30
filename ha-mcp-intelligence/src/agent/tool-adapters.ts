/**
 * Tool Adapters - Bridge existing intelligence tools to agent ToolRegistry
 */

import type { ToolSpec } from './types';
import type { DiagnoseEntityTool } from '../tools/diagnose-entity';
import type { AnalyzeErrorsTool } from '../tools/analyze-errors';

/**
 * Adapt DiagnoseEntityTool to ToolSpec interface
 */
export function createDiagnoseEntityAdapter(tool: DiagnoseEntityTool): ToolSpec {
  return {
    name: 'diagnose_entity',
    description: 'Diagnose entity issues with dependency analysis and root cause detection',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: {
          type: 'string',
          description: 'Entity ID to diagnose (e.g., sensor.hvac_power)',
        },
      },
      required: ['entity_id'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        diagnosis: { type: 'string' },
        recommendations: { type: 'array', items: { type: 'string' } },
      },
    },
    invoke: async (args, ctx) => {
      // Validate args
      if (!args || typeof args !== 'object' || !('entity_id' in args)) {
        throw new Error('entity_id is required');
      }

      const typedArgs = args as { entity_id: string };
      return await tool.execute(typedArgs);
    },
    cost: {
      estimatedMs: 500,
      estimatedTokens: 100,
    },
    safety: {
      requiresActuation: false,
      riskLevel: 'safe',
    },
  };
}

/**
 * Adapt AnalyzeErrorsTool to ToolSpec interface
 */
export function createAnalyzeErrorsAdapter(tool: AnalyzeErrorsTool): ToolSpec {
  return {
    name: 'analyze_errors',
    description: 'Analyze Home Assistant error logs with pattern detection and impact assessment',
    inputSchema: {
      type: 'object',
      properties: {
        hours_ago: {
          type: 'number',
          description: 'How many hours back to analyze (default: 24)',
          default: 24,
        },
        severity: {
          type: 'string',
          enum: ['error', 'warning', 'all'],
          description: 'Severity filter',
          default: 'error',
        },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        analysis: { type: 'string' },
        patterns: { type: 'array', items: { type: 'object' } },
      },
    },
    invoke: async (args) => {
      const typedArgs = (args || {}) as { hours_ago?: number; severity?: string };
      return await tool.execute(typedArgs);
    },
    cost: {
      estimatedMs: 1000,
      estimatedTokens: 200,
    },
    safety: {
      requiresActuation: false,
      riskLevel: 'safe',
    },
  };
}
