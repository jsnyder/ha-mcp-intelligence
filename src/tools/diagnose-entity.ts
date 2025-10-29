import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { BackgroundIndexer } from '../intelligence/background-indexer.js';
import { SupervisorClient } from '../server/supervisor-client.js';
import { Logger } from '../utils/logger.js';
import { validateEntityId, validateBoolean } from '../utils/validation.js';

export interface DiagnoseEntityArgs {
  entity_id: string;
  include_root_cause?: boolean;
  include_impact?: boolean;
}

export interface DiagnosisResult {
  entity_id: string;
  status: 'healthy' | 'unavailable' | 'unknown' | 'warning';
  current_state: string;
  last_changed: string;
  device?: {
    id: string;
    name: string;
    manufacturer?: string;
    model?: string;
  };
  area?: {
    id: string;
    name: string;
  };
  root_causes?: string[];
  impact?: {
    affected_entities: string[];
    affected_automations: string[];
  };
  recommendations: string[];
  metadata: {
    platform?: string;
    domain: string;
    disabled: boolean;
  };
}

export class DiagnoseEntityTool {
  private logger = new Logger('DiagnoseEntityTool');
  private indexer: BackgroundIndexer;

  constructor(indexer: BackgroundIndexer) {
    this.indexer = indexer;
  }

  getToolDefinition(): Tool {
    return {
      name: 'diagnose_entity',
      description: 'Diagnose an entity and identify root causes of issues. Returns comprehensive diagnosis including state, dependencies, root causes, and recommendations.',
      inputSchema: {
        type: 'object',
        properties: {
          entity_id: {
            type: 'string',
            description: 'Entity ID to diagnose (e.g., sensor.living_room_temperature)',
          },
          include_root_cause: {
            type: 'boolean',
            description: 'Include root cause analysis (default: true)',
            default: true,
          },
          include_impact: {
            type: 'boolean',
            description: 'Include impact analysis showing affected entities (default: true)',
            default: true,
          },
        },
        required: ['entity_id'],
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<DiagnosisResult> {
    const typedArgs = args as Partial<DiagnoseEntityArgs>;

    // Validate required parameters
    if (!typedArgs.entity_id) {
      throw new Error('entity_id parameter is required');
    }

    const entity_id = validateEntityId(typedArgs.entity_id);
    const include_root_cause = validateBoolean(typedArgs.include_root_cause, true);
    const include_impact = validateBoolean(typedArgs.include_impact, true);

    this.logger.info(`Diagnosing entity: ${entity_id}`);

    // Get entity state
    const entity = this.indexer.getEntity(entity_id);
    if (!entity) {
      throw new Error(`Entity not found: ${entity_id}`);
    }

    // Get entity node from dependency graph
    const node = this.indexer.getEntityNode(entity_id);
    if (!node) {
      throw new Error(`Entity node not found in dependency graph: ${entity_id}`);
    }

    // Get device info
    let device: DiagnosisResult['device'];
    if (node.device_id) {
      const deviceInfo = this.indexer.getDevice(node.device_id);
      if (deviceInfo) {
        device = {
          id: deviceInfo.id,
          name: deviceInfo.name,
          manufacturer: deviceInfo.manufacturer,
          model: deviceInfo.model,
        };
      }
    }

    // Get area info
    let area: DiagnosisResult['area'];
    if (node.area_id) {
      const areaInfo = this.indexer.getArea(node.area_id);
      if (areaInfo) {
        area = {
          id: areaInfo.area_id,
          name: areaInfo.name,
        };
      }
    }

    // Determine status
    let status: DiagnosisResult['status'] = 'healthy';
    if (entity.state === 'unavailable') {
      status = 'unavailable';
    } else if (entity.state === 'unknown') {
      status = 'unknown';
    } else if (node.disabled) {
      status = 'warning';
    }

    // Build result
    const result: DiagnosisResult = {
      entity_id,
      status,
      current_state: entity.state,
      last_changed: entity.last_changed,
      device,
      area,
      recommendations: [],
      metadata: {
        platform: node.platform,
        domain: node.domain,
        disabled: node.disabled,
      },
    };

    // Root cause analysis
    if (include_root_cause && status !== 'healthy') {
      const rootCauses = this.indexer.getRootCauses(entity_id);
      result.root_causes = rootCauses;

      // Add recommendations based on root causes
      if (rootCauses.length > 0) {
        result.recommendations.push(
          `Root cause analysis found ${rootCauses.length} unavailable dependencies: ${rootCauses.join(', ')}`
        );
        result.recommendations.push(
          'Check if these entities are properly configured and their integrations are loaded'
        );
      } else if (status === 'unavailable') {
        result.recommendations.push('Entity is unavailable but has no dependencies. Check:');
        result.recommendations.push('  - Integration configuration');
        result.recommendations.push('  - Device connectivity');
        result.recommendations.push('  - Home Assistant logs for errors');
      }
    }

    // Impact analysis
    if (include_impact) {
      const dependents = Array.from(node.dependents);
      const affectedAutomations = dependents.filter(id => id.startsWith('automation.'));
      const affectedEntities = dependents.filter(id => !id.startsWith('automation.'));

      result.impact = {
        affected_entities: affectedEntities,
        affected_automations: affectedAutomations,
      };

      if (status !== 'healthy' && dependents.length > 0) {
        result.recommendations.push(
          `This entity's issues may affect ${dependents.length} other entities/automations`
        );
      }
    }

    // Additional recommendations
    if (node.disabled) {
      result.recommendations.push('Entity is disabled. Enable it in the entity registry if needed.');
    }

    if (entity.attributes.restored === true) {
      result.recommendations.push(
        'Entity state is restored from previous session. May be stale if integration failed to start.'
      );
    }

    return result;
  }
}
