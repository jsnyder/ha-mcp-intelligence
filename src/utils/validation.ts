/**
 * Input validation utilities for MCP tools
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Validate Home Assistant entity ID format
 * Format: domain.object_id
 * Example: sensor.living_room_temperature
 */
export function validateEntityId(entityId: unknown): string {
  if (typeof entityId !== 'string') {
    throw new ValidationError('entity_id must be a string');
  }

  if (entityId.length === 0) {
    throw new ValidationError('entity_id cannot be empty');
  }

  if (entityId.length > 255) {
    throw new ValidationError('entity_id exceeds maximum length of 255 characters');
  }

  // Pattern: lowercase letters, numbers, underscores only
  // Format: domain.object_id
  const pattern = /^[a-z_]+\.[a-z0-9_]+$/;
  if (!pattern.test(entityId)) {
    throw new ValidationError(
      `Invalid entity_id format: "${entityId}". ` +
      'Must match pattern: domain.object_id (lowercase letters, numbers, underscores only)'
    );
  }

  return entityId;
}

/**
 * Validate timeframe parameter
 */
export function validateTimeframe(timeframe: unknown): '1h' | '24h' | '7d' {
  if (typeof timeframe !== 'string') {
    throw new ValidationError('timeframe must be a string');
  }

  const validTimeframes = ['1h', '24h', '7d'] as const;
  if (!validTimeframes.includes(timeframe as '1h' | '24h' | '7d')) {
    throw new ValidationError(
      `Invalid timeframe: "${timeframe}". Must be one of: ${validTimeframes.join(', ')}`
    );
  }

  return timeframe as '1h' | '24h' | '7d';
}

/**
 * Validate severity parameter
 */
export function validateSeverity(severity: unknown): 'warning' | 'error' | 'critical' {
  if (typeof severity !== 'string') {
    throw new ValidationError('severity must be a string');
  }

  const validSeverities = ['warning', 'error', 'critical'] as const;
  if (!validSeverities.includes(severity as 'warning' | 'error' | 'critical')) {
    throw new ValidationError(
      `Invalid severity: "${severity}". Must be one of: ${validSeverities.join(', ')}`
    );
  }

  return severity as 'warning' | 'error' | 'critical';
}

/**
 * Validate boolean parameter
 */
export function validateBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true' || lower === '1' || lower === 'yes') {
      return true;
    }
    if (lower === 'false' || lower === '0' || lower === 'no') {
      return false;
    }
  }

  throw new ValidationError(`Invalid boolean value: "${value}"`);
}
