import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { BackgroundIndexer } from '../intelligence/background-indexer.js';
import { SupervisorClient } from '../server/supervisor-client.js';
import { Logger } from '../utils/logger.js';
import { validateTimeframe, validateSeverity } from '../utils/validation.js';

export interface AnalyzeErrorsArgs {
  timeframe?: '1h' | '24h' | '7d';
  severity?: 'warning' | 'error' | 'critical';
}

export interface ErrorIncident {
  id: string;
  timestamp: string;
  severity: 'warning' | 'error' | 'critical';
  component: string;
  message: string;
  entity_ids: string[];
  stack_trace?: string;
  related_incidents: string[];
  root_cause?: {
    entity_id: string;
    reason: string;
  };
}

export interface AnalyzeErrorsResult {
  timeframe: string;
  total_incidents: number;
  incidents: ErrorIncident[];
  cascades: Array<{
    root_incident_id: string;
    affected_incident_ids: string[];
    description: string;
  }>;
  recommendations: string[];
}

export class AnalyzeErrorsTool {
  private logger = new Logger('AnalyzeErrorsTool');
  private indexer: BackgroundIndexer;
  private supervisorClient: SupervisorClient | null = null;

  constructor(indexer: BackgroundIndexer) {
    this.indexer = indexer;
  }

  getToolDefinition(): Tool {
    return {
      name: 'analyze_errors',
      description: 'Analyze recent errors and warnings in Home Assistant. Groups related incidents, identifies cascades, and suggests root causes.',
      inputSchema: {
        type: 'object',
        properties: {
          timeframe: {
            type: 'string',
            enum: ['1h', '24h', '7d'],
            description: 'Timeframe to analyze (default: 24h)',
            default: '24h',
          },
          severity: {
            type: 'string',
            enum: ['warning', 'error', 'critical'],
            description: 'Minimum severity level to include (default: warning)',
            default: 'warning',
          },
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<AnalyzeErrorsResult> {
    const typedArgs = args as Partial<AnalyzeErrorsArgs>;

    // Validate parameters with defaults
    const timeframe = typedArgs.timeframe
      ? validateTimeframe(typedArgs.timeframe)
      : '24h';
    const severity = typedArgs.severity
      ? validateSeverity(typedArgs.severity)
      : 'warning';

    this.logger.info(`Analyzing errors: timeframe=${timeframe}, severity=${severity}`);

    // Initialize supervisor client if needed
    if (!this.supervisorClient) {
      const token = process.env.SUPERVISOR_TOKEN || '';
      this.supervisorClient = new SupervisorClient({ supervisorToken: token });
      await this.supervisorClient.connect();
    }

    // Parse timeframe
    const hoursAgo = this.parseTimeframe(timeframe);
    const startTime = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);

    // Fetch error log
    const errorLog = await this.supervisorClient.getErrorLog();

    // Parse log entries
    const incidents = this.parseLogEntries(errorLog, startTime, severity);

    // Detect cascades (related errors)
    const cascades = this.detectCascades(incidents);

    // Generate recommendations
    const recommendations = this.generateRecommendations(incidents, cascades);

    return {
      timeframe,
      total_incidents: incidents.length,
      incidents,
      cascades,
      recommendations,
    };
  }

  private parseTimeframe(timeframe: string): number {
    switch (timeframe) {
      case '1h':
        return 1;
      case '24h':
        return 24;
      case '7d':
        return 168;
      default:
        return 24;
    }
  }

  private parseLogEntries(
    logContent: string,
    startTime: Date,
    minSeverity: string
  ): ErrorIncident[] {
    const incidents: ErrorIncident[] = [];
    const lines = logContent.split('\n');

    const severityLevel = { warning: 1, error: 2, critical: 3 };
    const minLevel = severityLevel[minSeverity as keyof typeof severityLevel] || 1;

    let currentIncident: Partial<ErrorIncident> | null = null;
    let incidentCounter = 0;

    for (const line of lines) {
      // Match log pattern: YYYY-MM-DD HH:MM:SS LEVEL (component) message
      const match = line.match(
        /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(WARNING|ERROR|CRITICAL)\s+\(([^)]+)\)\s+(.+)$/
      );

      if (match) {
        // Save previous incident
        if (currentIncident && currentIncident.severity) {
          incidents.push(currentIncident as ErrorIncident);
        }

        const [, timestamp, severity, component, message] = match;
        const incidentTime = new Date(timestamp);

        if (incidentTime < startTime) {
          continue;
        }

        const severityNormalized = severity.toLowerCase() as 'warning' | 'error' | 'critical';
        const level = severityLevel[severityNormalized];

        if (level >= minLevel) {
          // Extract entity IDs from message
          const entityIds = this.extractEntityIds(message);

          currentIncident = {
            id: `incident_${++incidentCounter}`,
            timestamp,
            severity: severityNormalized,
            component,
            message,
            entity_ids: entityIds,
            related_incidents: [],
          };
        } else {
          currentIncident = null;
        }
      } else if (currentIncident && line.startsWith(' ')) {
        // Stack trace continuation
        if (!currentIncident.stack_trace) {
          currentIncident.stack_trace = line.trim();
        } else {
          currentIncident.stack_trace += '\n' + line.trim();
        }
      }
    }

    // Add last incident
    if (currentIncident && currentIncident.severity) {
      incidents.push(currentIncident as ErrorIncident);
    }

    return incidents;
  }

  private extractEntityIds(message: string): string[] {
    const matches = message.match(/[a-z_]+\.[a-z0-9_]+/g);
    return matches ? Array.from(new Set(matches)) : [];
  }

  private detectCascades(incidents: ErrorIncident[]): AnalyzeErrorsResult['cascades'] {
    const cascades: AnalyzeErrorsResult['cascades'] = [];

    // Group incidents by entity
    const byEntity = new Map<string, ErrorIncident[]>();
    for (const incident of incidents) {
      for (const entityId of incident.entity_ids) {
        if (!byEntity.has(entityId)) {
          byEntity.set(entityId, []);
        }
        byEntity.get(entityId)!.push(incident);
      }
    }

    // Find cascades using dependency graph
    for (const incident of incidents) {
      if (incident.entity_ids.length === 0) continue;

      const rootEntityId = incident.entity_ids[0];
      const node = this.indexer.getEntityNode(rootEntityId);

      if (node && node.dependents.size > 0) {
        // Check if dependents also have errors
        const affectedIncidents = incidents.filter((other) => {
          if (other.id === incident.id) return false;

          return other.entity_ids.some((entityId) => node.dependents.has(entityId));
        });

        if (affectedIncidents.length > 0) {
          cascades.push({
            root_incident_id: incident.id,
            affected_incident_ids: affectedIncidents.map((i) => i.id),
            description: `${incident.component} error in ${rootEntityId} cascaded to ${affectedIncidents.length} dependent entities`,
          });

          // Mark relationships
          incident.related_incidents = affectedIncidents.map((i) => i.id);
        }
      }
    }

    return cascades;
  }

  private generateRecommendations(
    incidents: ErrorIncident[],
    cascades: AnalyzeErrorsResult['cascades']
  ): string[] {
    const recommendations: string[] = [];

    if (incidents.length === 0) {
      recommendations.push('No errors or warnings found in the specified timeframe.');
      return recommendations;
    }

    // Recommend focusing on root causes
    if (cascades.length > 0) {
      const rootIncidentIds = new Set(cascades.map((c) => c.root_incident_id));
      recommendations.push(
        `Found ${cascades.length} error cascade(s). Focus on resolving these root causes first:`
      );

      for (const cascade of cascades) {
        const incident = incidents.find((i) => i.id === cascade.root_incident_id);
        if (incident) {
          recommendations.push(`  - ${incident.component}: ${incident.message.substring(0, 80)}...`);
        }
      }
    }

    // Identify most common components
    const componentCounts = new Map<string, number>();
    for (const incident of incidents) {
      componentCounts.set(incident.component, (componentCounts.get(incident.component) || 0) + 1);
    }

    const topComponents = Array.from(componentCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    if (topComponents.length > 0) {
      recommendations.push('Most problematic components:');
      for (const [component, count] of topComponents) {
        recommendations.push(`  - ${component}: ${count} incidents`);
      }
    }

    // Check for unavailable entities mentioned in errors
    const unavailableEntities = new Set<string>();
    for (const incident of incidents) {
      for (const entityId of incident.entity_ids) {
        const entity = this.indexer.getEntity(entityId);
        if (entity && entity.state === 'unavailable') {
          unavailableEntities.add(entityId);
        }
      }
    }

    if (unavailableEntities.size > 0) {
      recommendations.push(
        `${unavailableEntities.size} entities mentioned in errors are currently unavailable. Use diagnose_entity to investigate.`
      );
    }

    return recommendations;
  }
}
