/**
 * The process logger: pino, loaded through `require` so OpenTelemetry's pino instrumentation (which patches CommonJS
 * loads) sends every line to Clickland with its trace and span; an ESM `import` would bypass it. Fastify and ingest
 * share it.
 */
import { createRequire } from 'node:module';
import type { Logger, LoggerOptions } from 'pino';

const require = createRequire(import.meta.url);

export function createLogger(options: LoggerOptions = {}): Logger {
  const pino = require('pino') as (o: LoggerOptions) => Logger;
  return pino({ level: process.env.LANDLEDGER_LOG === 'off' ? 'silent' : 'info', ...options });
}
