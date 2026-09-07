export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levelRank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogContext {
  sessionId?: string;
  requestId?: string;
  action?: string;
  transport?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(context: LogContext): Logger;
  isEnabled(level: LogLevel): boolean;
}

export function createLogger(level: LogLevel = 'info', baseContext: LogContext = {}): Logger {
  return new ConsoleLogger(level, baseContext);
}

class ConsoleLogger implements Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly baseContext: LogContext,
  ) {}

  debug(message: string, context?: LogContext): void {
    this.write('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.write('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.write('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.write('error', message, context);
  }

  child(context: LogContext): Logger {
    return new ConsoleLogger(this.level, { ...this.baseContext, ...context });
  }

  isEnabled(level: LogLevel): boolean {
    return levelRank[level] >= levelRank[this.level];
  }

  private write(level: LogLevel, message: string, context?: LogContext): void {
    if (!this.isEnabled(level)) {
      return;
    }

    const merged = sanitizeContext({ ...this.baseContext, ...context });
    const suffix = merged && Object.keys(merged).length > 0 ? ` ${JSON.stringify(merged)}` : '';
    const line = `[pinout:${level}] ${message}${suffix}`;

    switch (level) {
      case 'debug':
      case 'info':
        console.log(line);
        break;
      case 'warn':
        console.warn(line);
        break;
      case 'error':
        console.error(line);
        break;
    }
  }
}

function sanitizeContext(context: LogContext): LogContext | undefined {
  const sanitized: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    if (key === 'payload' || key === 'secret' || key === 'token') {
      sanitized[key] = '[redacted]';
      continue;
    }
    sanitized[key] = value;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}
