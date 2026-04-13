import { Router } from "express";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const commentsRouter = Router();

const FILE = join("/home/runner/workspace", "comments.json");

interface Comentario { id: string; autor: string; texto: string; }

function leer(): Comentario[] {
  try { return existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : []; }
  catch { return []; }
}
function guardar(data: Comentario[]) {
  writeFileSync(FILE, JSON.stringify(data), "utf8");
}

commentsRouter.get("/comments", (_req, res) => {
  res.json(leer());
});

commentsRouter.post("/comments", (req, res) => {
  const { autor = "Anónimo", texto } = req.body as { autor?: string; texto?: string };
  if (!texto?.trim()) { res.status(400).json({ error: "texto requerido" }); return; }
  const nuevo: Comentario = { id: Date.now().toString(), autor: autor.trim() || "Anónimo", texto: texto.trim() };
  const lista = [...leer(), nuevo];
  guardar(lista);
  res.status(201).json(nuevo);
});

commentsRouter.delete("/comments/:id", (req, res) => {
  const lista = leer().filter((c) => c.id !== req.params.id);
  guardar(lista);
  res.json({ ok: true });
});

export default commentsRouter;
