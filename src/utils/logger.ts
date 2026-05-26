import winston from "winston";
import TransportStream from "winston-transport";

const isProduction = process.env.NODE_ENV === "production";
const lokiUrl = process.env.LOKI_URL;
console.log("[Logger] LOKI_URL =", lokiUrl ?? "NOT SET — Loki disabled");

// Simple custom Loki transport using fetch (winston-loki has silent push failures)
class SimpleLokiTransport extends TransportStream {
  private host: string;
  private labels: Record<string, string>;

  constructor(opts: { host: string; labels: Record<string, string>; level?: string }) {
    super({ level: opts.level ?? "info" });
    this.host = opts.host.replace(/\/$/, "");
    this.labels = opts.labels;
  }

  log(info: any, callback: () => void) {
    const { level, message, ...meta } = info;
    const ts = (BigInt(Date.now()) * 1_000_000n).toString();
    const line = JSON.stringify({ level, message, ...meta });
    const payload = {
      streams: [{ stream: { ...this.labels, level }, values: [[ts, line]] }],
    };

    fetch(`${this.host}/loki/api/v1/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch((err) => console.error("[Loki push error]", err.message));

    callback();
  }
}

function createLogger(module?: string) {
  const moduleTransports: winston.transport[] = [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: "HH:mm:ss" }),
        winston.format.printf(({ timestamp, level, message, module: mod, ...meta }) => {
          const modTag = mod ? `[${mod}]` : "";
          const metaStr = Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
          return `${timestamp} ${level} ${modTag} ${message}${metaStr}`;
        })
      ),
    }),
  ];

  if (lokiUrl) {
    moduleTransports.push(
      new SimpleLokiTransport({
        host: lokiUrl,
        labels: {
          app: "job-management-backend",
          env: process.env.NODE_ENV ?? "development",
          ...(module ? { module } : {}),
        },
      })
    );
  }

  const logger = winston.createLogger({
    level: isProduction ? "info" : "debug",
    transports: moduleTransports,
  });

  return {
    info: (message: string, meta?: Record<string, unknown>) =>
      logger.info(message, { module, ...meta }),
    warn: (message: string, meta?: Record<string, unknown>) =>
      logger.warn(message, { module, ...meta }),
    error: (message: string, meta?: Record<string, unknown>) =>
      logger.error(message, { module, ...meta }),
    debug: (message: string, meta?: Record<string, unknown>) =>
      logger.debug(message, { module, ...meta }),
  };
}

export const logger = createLogger();
export const webhookLogger = createLogger("webhook");
export const pollingLogger = createLogger("polling");
export const integrationLogger = createLogger("integration");
export const workflowLogger = createLogger("workflow");
export const authLogger = createLogger("auth");
export const jobLogger = createLogger("job");
export const smtpLogger = createLogger("smtp");
export const dbLogger = createLogger("db");
