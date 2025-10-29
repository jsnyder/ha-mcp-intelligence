export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
};

export class Logger {
  private context: string;
  private minLevel: LogLevel;

  constructor(context: string, minLevel?: LogLevel) {
    this.context = context;
    this.minLevel = minLevel || (process.env.LOG_LEVEL as LogLevel) || 'info';
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.minLevel];
  }

  private format(level: string, message: string, data?: unknown): string {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [${this.context}]`;
    const msg = `${prefix} ${message}`;

    if (data !== undefined) {
      return `${msg} ${JSON.stringify(data, null, 2)}`;
    }
    return msg;
  }

  debug(message: string, data?: unknown): void {
    if (this.shouldLog('debug')) {
      console.debug(this.format('debug', message, data));
    }
  }

  info(message: string, data?: unknown): void {
    if (this.shouldLog('info')) {
      console.info(this.format('info', message, data));
    }
  }

  warning(message: string, data?: unknown): void {
    if (this.shouldLog('warning')) {
      console.warn(this.format('warning', message, data));
    }
  }

  error(message: string, error?: unknown): void {
    if (this.shouldLog('error')) {
      const errorData = error instanceof Error
        ? { message: error.message, stack: error.stack }
        : error;
      console.error(this.format('error', message, errorData));
    }
  }
}
