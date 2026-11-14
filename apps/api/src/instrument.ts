/**
 * Loaded with `node --import` (and `tsx --import`) before main.ts, so OpenTelemetry patches http and pino before
 * Fastify loads them. Reads the workspace .env first, so OTEL_* and LANDLEDGER_TELEMETRY apply.
 */
import { loadWorkspaceEnv } from '@landledger/schema';
import { startTelemetry } from './telemetry.js';

loadWorkspaceEnv();
startTelemetry('landledger-api');
