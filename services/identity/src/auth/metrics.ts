import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Controller, Get } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';
import { Public } from './jwt.strategy';

/**
 * RED metrics -- Rate, Errors, Duration -- exposed for Prometheus.
 *
 * Labels deliberately use the ROUTE PATTERN, not the resolved URL. Putting an
 * id in a label produces unbounded cardinality: one time series per work order
 * would eventually take the metrics store down, which is a far worse outage
 * than the one you were trying to observe.
 */
export const registry = new Registry();
registry.setDefaultLabels({ service: process.env.SERVICE_NAME || 'unknown' });
collectDefaultMetrics({ register: registry });

export const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'HTTP requests by route, method and status',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route', 'status'],
  // Buckets chosen around the SLO, not spread evenly. A 250ms objective wants
  // resolution at 250ms; uniform buckets waste resolution where nothing happens.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const domainEvents = new Counter({
  name: 'fn_domain_events_total',
  help: 'Domain events published or consumed',
  labelNames: ['event_type', 'direction', 'outcome'],
  registers: [registry],
});

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const http = ctx.switchToHttp();
    const req = http.getRequest();
    const started = process.hrtime.bigint();

    const record = () => {
      const res = http.getResponse();
      const route = req.route?.path || req.url?.split('?')[0] || 'unknown';
      const labels = { method: req.method, route, status: String(res.statusCode) };
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      httpRequests.inc(labels);
      httpDuration.observe(labels, seconds);
    };

    return next.handle().pipe(tap({ next: record, error: record }));
  }
}

@Controller()
export class MetricsController {
  @Public() @Get('metrics')
  async metrics() { return registry.metrics(); }
}
