const LOG_PREFIX = '[MCP-SERVER]';

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function log(level: LogLevel, ...args: any[]) {
  const timestamp = new Date().toISOString();
  // 根据日志级别选择不同的 console 方法
  const logFunction =
    console[level.toLowerCase() as 'log' | 'warn' | 'error' | 'debug'] ||
    console.log;

  // 优化错误对象的打印
  const finalArgs = args.map(arg => {
    if (arg instanceof Error) {
      // 为了更清晰的日志，我们只打印错误消息和堆栈
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
  // debug 方法需要一个布尔值来决定是否打印
  debug: (debugMode: boolean, ...args: unknown[]) => {
    if (debugMode) {
      log('DEBUG', ...args);
    }
  },
};
