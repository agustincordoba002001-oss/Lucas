import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import { existsSync } from "fs";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

app.use("/api", router);

const FRONTEND_DIST = process.env["FRONTEND_DIST"]
  ?? path.resolve(process.cwd(), "../lolo-cd/dist/public");

if (existsSync(FRONTEND_DIST)) {
  logger.info({ FRONTEND_DIST }, "Serving frontend static files");
  app.use(express.static(FRONTEND_DIST));
  app.get(/^\/(?!api\/).*/, (_req, res, next) => {
    const indexHtml = path.join(FRONTEND_DIST, "index.html");
    if (existsSync(indexHtml)) {
      res.sendFile(indexHtml);
    } else {
      next();
    }
  });
} else {
  logger.warn(
    { FRONTEND_DIST },
    "Frontend dist not found — only /api routes will be served. Run `pnpm --filter @workspace/lolo-cd run build`.",
  );
  app.get("/", (_req, res) => {
    res
      .status(200)
      .type("html")
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><title>Motor Lolo CD</title></head>` +
          `<body style="font-family:Inter,system-ui;padding:2rem;max-width:720px;margin:auto;color:#222;">` +
          `<h1>Motor Lolo CD — API server</h1>` +
          `<p>El frontend no está construido. Ejecuta:</p>` +
          `<pre style="background:#f4f4f5;padding:1rem;border-radius:8px;">PORT=5173 BASE_PATH=/ pnpm --filter @workspace/lolo-cd run build</pre>` +
          `<p>Endpoints disponibles bajo <code>/api/*</code>.</p>` +
          `</body></html>`,
      );
  });
}

export default app;
