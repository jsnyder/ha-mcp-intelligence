import { SupervisorClient, HAEntity, HADeviceRegistry, HAEntityRegistry, HAAreaRegistry } from '../server/supervisor-client.js';
import { Logger } from '../utils/logger.js';

export interface IndexerConfig {
  supervisorToken: string;
  ttlSeconds: number;
}

export interface EntityNode {
  entity_id: string;
  domain: string;
  object_id: string;
  state: string;
  device_id?: string;
  area_id?: string;
  dependencies: Set<string>; // Entity IDs this entity depends on
  dependents: Set<string>;   // Entity IDs that depend on this entity
  package?: string;           // Package file if detected
  platform?: string;
  disabled: boolean;
  unavailable: boolean;
  last_changed: Date;
}

export interface DependencyGraph {
  nodes: Map<string, EntityNode>;
  edges: Array<{ from: string; to: string; type: 'template' | 'automation' | 'script' }>;
}

export class BackgroundIndexer {
  private logger = new Logger('BackgroundIndexer');
  private client: SupervisorClient;
  private ttl: number;
  private intervalId: NodeJS.Timeout | null = null;

  // Memory limits to prevent unbounded growth
  private readonly MAX_ENTITIES = 10000;
  private readonly MAX_DEVICES = 1000;
  private readonly MAX_AREAS = 100;

  // Cached data
  private entities = new Map<string, HAEntity>();
  private deviceRegistry = new Map<string, HADeviceRegistry>();
  private entityRegistry = new Map<string, HAEntityRegistry>();
  private areaRegistry = new Map<string, HAAreaRegistry>();
  private dependencyGraph: DependencyGraph = { nodes: new Map(), edges: [] };
  private lastUpdate: Date | null = null;

  constructor(config: IndexerConfig) {
    this.client = new SupervisorClient({
      supervisorToken: config.supervisorToken,
    });
    this.ttl = config.ttlSeconds * 1000;
  }

  async start(): Promise<void> {
    this.logger.info('Connecting to Supervisor WebSocket...');
    await this.client.connect();

    this.logger.info('Performing initial index...');
    await this.refresh();

    this.logger.info(`Starting background refresh (TTL: ${this.ttl / 1000}s)`);
    this.intervalId = setInterval(() => this.refresh(), this.ttl);
  }

  async stop(): Promise<void> {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    await this.client.disconnect();
  }

  async refresh(): Promise<void> {
    try {
      this.logger.debug('Refreshing index...');

      // Fetch all registries in parallel
      const [states, devices, entities, areas] = await Promise.all([
        this.client.getStates(),
        this.client.getDeviceRegistry(),
        this.client.getEntityRegistry(),
        this.client.getAreaRegistry(),
      ]);

      // Apply size limits and warn if exceeded
      if (states.length > this.MAX_ENTITIES) {
        this.logger.warning(`Entity count (${states.length}) exceeds limit (${this.MAX_ENTITIES}), will truncate`);
      }
      if (devices.length > this.MAX_DEVICES) {
        this.logger.warning(`Device count (${devices.length}) exceeds limit (${this.MAX_DEVICES}), will truncate`);
      }
      if (areas.length > this.MAX_AREAS) {
        this.logger.warning(`Area count (${areas.length}) exceeds limit (${this.MAX_AREAS}), will truncate`);
      }

      // Update caches with size limits
      this.entities.clear();
      states.slice(0, this.MAX_ENTITIES).forEach(entity => {
        this.entities.set(entity.entity_id, entity);
      });

      this.deviceRegistry.clear();
      devices.slice(0, this.MAX_DEVICES).forEach(device => {
        this.deviceRegistry.set(device.id, device);
      });

      this.entityRegistry.clear();
      entities.slice(0, this.MAX_ENTITIES).forEach(entity => {
        this.entityRegistry.set(entity.entity_id, entity);
      });

      this.areaRegistry.clear();
      areas.slice(0, this.MAX_AREAS).forEach(area => {
        this.areaRegistry.set(area.area_id, area);
      });

      // Build dependency graph
      await this.buildDependencyGraph();

      this.lastUpdate = new Date();
      this.logger.info(`Index refreshed: ${this.entities.size} entities, ${this.deviceRegistry.size} devices, ${this.areaRegistry.size} areas`);
    } catch (error) {
      this.logger.error('Failed to refresh index', error);
    }
  }

  private async buildDependencyGraph(): Promise<void> {
    const graph: DependencyGraph = { nodes: new Map(), edges: [] };

    // Build nodes
    for (const [entityId, entity] of this.entities) {
      const [domain, objectId] = entityId.split('.', 2);
      const registryEntry = this.entityRegistry.get(entityId);

      const node: EntityNode = {
        entity_id: entityId,
        domain,
        object_id: objectId,
        state: entity.state,
        device_id: registryEntry?.device_id,
        area_id: registryEntry?.area_id,
        dependencies: new Set(),
        dependents: new Set(),
        platform: registryEntry?.platform,
        disabled: !!registryEntry?.disabled_by,
        unavailable: entity.state === 'unavailable' || entity.state === 'unknown',
        last_changed: new Date(entity.last_changed),
      };

      graph.nodes.set(entityId, node);
    }

    // Extract template dependencies
    for (const [entityId, entity] of this.entities) {
      const node = graph.nodes.get(entityId)!;

      // Extract dependencies from various template formats
      const templateAttrs = [
        entity.attributes.entity_id,
        entity.attributes.value_template,
        entity.attributes.state_template,
        entity.attributes.icon_template,
        entity.attributes.availability_template
      ].filter(Boolean);

      for (const template of templateAttrs) {
        if (typeof template === 'string') {
          const deps = this.extractDependencies(template);
          deps.forEach(depId => {
            if (graph.nodes.has(depId)) {
              node.dependencies.add(depId);
              graph.nodes.get(depId)!.dependents.add(entityId);
              graph.edges.push({ from: entityId, to: depId, type: 'template' });
            }
          });
        }
      }

      // Check automation triggers/conditions
      if (entity.attributes.id && entity.domain === 'automation') {
        const entityIds = entity.attributes.entity_id;
        if (Array.isArray(entityIds)) {
          entityIds.forEach((depId: string) => {
            if (graph.nodes.has(depId)) {
              node.dependencies.add(depId);
              graph.nodes.get(depId)!.dependents.add(entityId);
              graph.edges.push({ from: entityId, to: depId, type: 'automation' });
            }
          });
        }
      }
    }

    this.dependencyGraph = graph;
    this.logger.debug(`Dependency graph built: ${graph.nodes.size} nodes, ${graph.edges.length} edges`);
  }

  // Public accessors
  getEntity(entityId: string): HAEntity | undefined {
    return this.entities.get(entityId);
  }

  getEntityNode(entityId: string): EntityNode | undefined {
    return this.dependencyGraph.nodes.get(entityId);
  }

  getDevice(deviceId: string): HADeviceRegistry | undefined {
    return this.deviceRegistry.get(deviceId);
  }

  getArea(areaId: string): HAAreaRegistry | undefined {
    return this.areaRegistry.get(areaId);
  }

  getAllEntities(): HAEntity[] {
    return Array.from(this.entities.values());
  }

  getEntitiesByDomain(domain: string): HAEntity[] {
    return this.getAllEntities().filter(e => e.entity_id.startsWith(`${domain}.`));
  }

  getEntitiesByArea(areaId: string): HAEntity[] {
    const entityIds = Array.from(this.entityRegistry.values())
      .filter(e => e.area_id === areaId)
      .map(e => e.entity_id);

    return entityIds
      .map(id => this.entities.get(id))
      .filter((e): e is HAEntity => e !== undefined);
  }

  getDependencyChain(entityId: string): string[] {
    const visited = new Set<string>();
    const chain: string[] = [];

    const traverse = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      chain.push(id);

      const node = this.dependencyGraph.nodes.get(id);
      if (node) {
        node.dependencies.forEach(depId => traverse(depId));
      }
    };

    traverse(entityId);
    return chain;
  }

  getRootCauses(entityId: string): string[] {
    const chain = this.getDependencyChain(entityId);
    return chain.filter(id => {
      const node = this.dependencyGraph.nodes.get(id);
      return node && node.unavailable && node.dependencies.size === 0;
    });
  }

  getLastUpdate(): Date | null {
    return this.lastUpdate;
  }

  /**
   * Extract entity dependencies from template strings using multiple patterns
   */
  private extractDependencies(template: string): string[] {
    const dependencies = new Set<string>();

    // Pattern 1: states('entity_id') or state('entity_id')
    const pattern1 = /states?\(['"]([a-z_]+\.[a-z0-9_]+)['"]\)/g;
    let match;
    while ((match = pattern1.exec(template)) !== null) {
      dependencies.add(match[1]);
    }

    // Pattern 2: states.domain.entity
    const pattern2 = /states\.([a-z_]+)\.([a-z0-9_]+)/g;
    while ((match = pattern2.exec(template)) !== null) {
      dependencies.add(`${match[1]}.${match[2]}`);
    }

    // Pattern 3: is_state('entity_id', ...)
    const pattern3 = /is_state\(['"]([a-z_]+\.[a-z0-9_]+)['"]/g;
    while ((match = pattern3.exec(template)) !== null) {
      dependencies.add(match[1]);
    }

    // Pattern 4: state_attr('entity_id', ...)
    const pattern4 = /state_attr\(['"]([a-z_]+\.[a-z0-9_]+)['"]/g;
    while ((match = pattern4.exec(template)) !== null) {
      dependencies.add(match[1]);
    }

    // Pattern 5: {{ states('entity_id') }} with whitespace
    const pattern5 = /\{\{\s*states?\(['"]([a-z_]+\.[a-z0-9_]+)['"]\)\s*\}\}/g;
    while ((match = pattern5.exec(template)) !== null) {
      dependencies.add(match[1]);
    }

    return Array.from(dependencies);
  }
}
