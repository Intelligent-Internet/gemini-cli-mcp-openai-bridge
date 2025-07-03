const LOG_PREFIX = '[MCP-SERVER]';

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function log(level: LogLevel, ...args: any[]) {
  const timestamp = new Date().toISOString();
  // Select the appropriate console method based on the log level.
  const logFunction =
    console[level.toLowerCase() as 'log' | 'warn' | 'error' | 'debug'] ||
    console.log;

  // Optimize printing of error objects for clarity.
  const finalArgs = args.map(arg => {
    if (arg instanceof Error) {
      return { message: arg.message, stack: arg.stack };
    }
    return arg;
  });

  logFunction(`${timestamp} ${LOG_PREFIX} [${level}]`, ...finalArgs);
}

export const logger = {
  info: (...args: unknown[]) => log('INFO', ...args),
  warn: (...args: unknown[]) => log('WARN', ...args),
  error: (...args: unknown[]) => log('ERROR', ...args),
  // The debug method only logs if debugMode is true.
  debug: (debugMode: boolean, ...args: unknown[]) => {
    if (debugMode) {
      log('DEBUG', ...args);
    }
  },
};
