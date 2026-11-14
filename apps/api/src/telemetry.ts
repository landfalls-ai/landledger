import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | undefined;

/** Clickland's collector on this machine (OTLP over HTTP); every land app sends here. */
export const CLICKLAND_COLLECTOR = 'http://127.0.0.1:24318';

/**
 * Landledger's own traces, metrics and logs to Clickland, as Landbright's apps send theirs: one service per process
 * (`landledger-api`, `service.namespace=landledger`), HTTP server and client spans and durations, Node runtime metrics,
 * and every Fastify (pino) log line with its trace and span. On by default to Clickland's collector on this machine;
 * `OTEL_EXPORTER_OTLP_ENDPOINT` points elsewhere and `LANDLEDGER_TELEMETRY=off` (or `OTEL_SDK_DISABLED=true`) turns it
 * off. Started by instrument.ts through `--import`, before Fastify loads, so the instrumentations patch it.
 */
export function startTelemetry(serviceName: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (sdk) return true;
  if (env.LANDLEDGER_TELEMETRY === 'off' || env.OTEL_SDK_DISABLED === 'true') return false;
  env.OTEL_EXPORTER_OTLP_ENDPOINT ??= CLICKLAND_COLLECTOR;
  env.OTEL_EXPORTER_OTLP_PROTOCOL ??= 'http/protobuf';
  env.OTEL_TRACES_EXPORTER ??= 'otlp';
  env.OTEL_METRICS_EXPORTER ??= 'otlp';
  env.OTEL_LOGS_EXPORTER ??= 'otlp';
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME ?? serviceName,
      [ATTR_SERVICE_VERSION]: env.npm_package_version ?? '0.1.0',
      'service.namespace': 'landledger',
      'deployment.environment.name': env.LANDLEDGER_ENV ?? 'local',
    }),
    instrumentations: [
      new HttpInstrumentation({ ignoreIncomingRequestHook: (request) => request.url === '/api/health' }),
      new PinoInstrumentation(),
      new RuntimeNodeInstrumentation(),
    ],
  });
  sdk.start();
  return true;
}

export async function stopTelemetry(): Promise<void> {
  await sdk?.shutdown().catch(() => undefined);
  sdk = undefined;
}
