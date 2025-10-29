import WebSocket from 'ws';
import { Logger } from '../utils/logger.js';

export interface SupervisorClientConfig {
  supervisorToken: string;
  wsUrl?: string;
  httpUrl?: string;
}

export interface HAEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
  context: {
    id: string;
    parent_id?: string;
    user_id?: string;
  };
  domain?: string;
}

export interface HADeviceRegistry {
  id: string;
  name: string;
  model?: string;
  manufacturer?: string;
  config_entries: string[];
  area_id?: string;
  disabled_by?: string;
}

export interface HAEntityRegistry {
  entity_id: string;
  unique_id: string;
  platform: string;
  device_id?: string;
  area_id?: string;
  disabled_by?: string;
  entity_category?: string;
  original_name?: string;
  capabilities?: Record<string, any>;
}

export interface HAAreaRegistry {
  area_id: string;
  name: string;
  picture?: string;
}

export class SupervisorClient {
  private logger = new Logger('SupervisorClient');
  private token: string;
  private wsUrl: string;
  private httpUrl: string;
  private ws: WebSocket | null = null;
  private messageId = 1;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();

  // Reconnection handling
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private reconnectDelay = 1000; // Start with 1 second
  private pingInterval: NodeJS.Timeout | null = null;
  private isReconnecting = false;

  constructor(config: SupervisorClientConfig) {
    this.token = config.supervisorToken;

    // Support local testing outside Docker
    const haHost = process.env.HA_HOST;
    if (haHost) {
      // Local testing: connect directly to HA API
      this.wsUrl = config.wsUrl || `ws://${haHost}:8123/api/websocket`;
      this.httpUrl = config.httpUrl || `http://${haHost}:8123/api`;
    } else {
      // Docker: use Supervisor proxy
      this.wsUrl = config.wsUrl || `ws://supervisor/core/websocket`;
      this.httpUrl = config.httpUrl || `http://supervisor/core/api`;
    }

    this.logger.debug(`Supervisor URLs: ws=${this.wsUrl}, http=${this.httpUrl}`);
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.on('open', () => {
        this.logger.info('WebSocket connected to Supervisor');
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());

          // Handle auth_required
          if (message.type === 'auth_required') {
            this.logger.debug('Sending auth token');
            this.ws?.send(JSON.stringify({
              type: 'auth',
              access_token: this.token,
            }));
          }

          // Handle auth_ok
          if (message.type === 'auth_ok') {
            this.logger.info('Authenticated with Supervisor');
            this.reconnectAttempts = 0; // Reset on successful connection
            this.startHeartbeat();
            resolve();
          }

          // Handle auth_invalid
          if (message.type === 'auth_invalid') {
            reject(new Error('Authentication failed'));
          }

          // Handle result messages
          if (message.id !== undefined) {
            const pending = this.pendingRequests.get(message.id);
            if (pending) {
              this.pendingRequests.delete(message.id);
              if (message.success === false) {
                pending.reject(new Error(message.error?.message || 'Request failed'));
              } else {
                pending.resolve(message.result);
              }
            }
          }
        } catch (error) {
          this.logger.error('Failed to parse message', error);
        }
      });

      this.ws.on('error', (error) => {
        this.logger.error('WebSocket error', error);
        reject(error);
      });

      this.ws.on('close', () => {
        this.logger.warning('WebSocket connection closed');
        this.ws = null;

        // Clean up pending requests to prevent memory leak
        for (const [id, pending] of this.pendingRequests) {
          pending.reject(new Error('Connection closed'));
        }
        this.pendingRequests.clear();

        // Clear ping interval
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }

        // Attempt reconnection if not manually disconnected
        if (!this.isReconnecting) {
          this.reconnect().catch(err =>
            this.logger.error('Reconnection failed permanently', err)
          );
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    this.isReconnecting = true; // Prevent reconnection attempts

    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // Clean up pending requests
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new Error('Client disconnected'));
    }
    this.pendingRequests.clear();
  }

  private async reconnect(): Promise<void> {
    if (this.isReconnecting) {
      return;
    }

    this.isReconnecting = true;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error(`Max reconnection attempts (${this.maxReconnectAttempts}) reached`);
      this.isReconnecting = false;
      throw new Error('WebSocket connection failed permanently');
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    this.logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      await this.connect();
      this.isReconnecting = false;
      this.logger.info('Reconnection successful');
    } catch (error) {
      this.logger.error('Reconnection attempt failed', error);
      this.isReconnecting = false;
      await this.reconnect();
    }
  }

  private startHeartbeat(): void {
    // Clear any existing interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    // Send ping every 30 seconds
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
          this.logger.debug('Heartbeat ping sent');
        } catch (error) {
          this.logger.error('Failed to send heartbeat', error);
        }
      }
    }, 30000);
  }

  private async sendMessage<T = unknown>(type: string, data?: Record<string, unknown>): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const id = this.messageId++;
    const message = { id, type, ...data };

    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject
      });

      this.ws!.send(JSON.stringify(message));

      // Timeout after 30 seconds
      setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });
  }

  async getStates(): Promise<HAEntity[]> {
    return this.sendMessage('get_states');
  }

  async getState(entityId: string): Promise<HAEntity | null> {
    try {
      const states = await this.getStates();
      return states.find(s => s.entity_id === entityId) || null;
    } catch (error) {
      this.logger.error(`Failed to get state for ${entityId}`, error);
      return null;
    }
  }

  async getDeviceRegistry(): Promise<HADeviceRegistry[]> {
    const result = await this.sendMessage<HADeviceRegistry[]>('config/device_registry/list');
    return result;
  }

  async getEntityRegistry(): Promise<HAEntityRegistry[]> {
    const result = await this.sendMessage<HAEntityRegistry[]>('config/entity_registry/list');
    return result;
  }

  async getAreaRegistry(): Promise<HAAreaRegistry[]> {
    const result = await this.sendMessage<HAAreaRegistry[]>('config/area_registry/list');
    return result;
  }

  async renderTemplate(template: string): Promise<string> {
    const result = await this.sendMessage<string>('render_template', {
      template,
      report_errors: true,
    });
    return result;
  }

  async getHistory(
    entityIds: string[],
    startTime?: Date,
    endTime?: Date
  ): Promise<Record<string, HAEntity[]>> {
    // Use HTTP API for history (WebSocket doesn't support it well)
    const params = new URLSearchParams();
    params.append('filter_entity_id', entityIds.join(','));
    if (startTime) params.append('start_time', startTime.toISOString());
    if (endTime) params.append('end_time', endTime.toISOString());

    const response = await fetch(`${this.httpUrl}/history/period?${params}`, {
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const history = await response.json() as HAEntity[][];

    // Convert array response to map
    const result: Record<string, HAEntity[]> = {};
    for (let i = 0; i < entityIds.length && i < history.length; i++) {
      result[entityIds[i]] = history[i] || [];
    }

    return result;
  }

  async getLogbook(
    startTime?: Date,
    endTime?: Date,
    entityIds?: string[]
  ): Promise<unknown[]> {
    const params = new URLSearchParams();
    if (startTime) params.append('start_time', startTime.toISOString());
    if (endTime) params.append('end_time', endTime.toISOString());
    if (entityIds) params.append('entity', entityIds.join(','));

    const response = await fetch(`${this.httpUrl}/logbook?${params}`, {
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    return response.json() as Promise<unknown[]>;
  }

  async getErrorLog(): Promise<string> {
    const response = await fetch(`${this.httpUrl}/error_log`, {
      headers: {
        'Authorization': `Bearer ${this.token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    return response.text();
  }
}
