import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { nodeTypes, type CanvasNode, type NodePatch, type Point } from "./model.js";
import { openDocuments, readDocumentEdit, readTitle } from "./document-store.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dbPath = process.env.CANVAS_DB ?? resolve(root, "data", "canvas.sqlite");
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA busy_timeout = 5000;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL
  ) STRICT;
`);

const list = db.prepare("SELECT id, type, title, x, y FROM nodes ORDER BY rowid");
const insert = db.prepare("INSERT INTO nodes (id, type, title, x, y) VALUES (?, ?, ?, ?, ?)");
const update = db.prepare(`
  UPDATE nodes SET title = COALESCE(?, title), x = COALESCE(?, x), y = COALESCE(?, y)
  WHERE id = ? RETURNING id, type, title, x, y
`);
const remove = db.prepare("DELETE FROM nodes WHERE id = ?");
const documents = openDocuments(db);

const assets = new Map([
  ["/", { file: "public/home.html", type: "text/html; charset=utf-8" }],
  ["/narrative", { file: "public/documents.html", type: "text/html; charset=utf-8" }],
  ["/documents.css", { file: "public/documents.css", type: "text/css; charset=utf-8" }],
  ["/documents.js", { file: "dist/documents.js", type: "text/javascript; charset=utf-8" }],
  ["/canvas", { file: "public/index.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { file: "public/styles.css", type: "text/css; charset=utf-8" }],
  ["/canvas.js", { file: "dist/src/canvas.js", type: "text/javascript; charset=utf-8" }],
  ["/model.js", { file: "dist/src/model.js", type: "text/javascript; charset=utf-8" }],
]);

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readBody(request: IncomingMessage, limit = 4096): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      throw new RequestError(413, "请求内容过大");
    }
    chunks.push(chunk);
  }

  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // Invalid JSON and non-object JSON get the same response.
  }
  throw new RequestError(400, "请求需要一个 JSON 对象");
}

function readPoint(body: Record<string, unknown>): Point {
  const { x, y } = body;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new RequestError(400, "节点坐标无效");
  }
  return { x, y };
}

function readPatch(body: Record<string, unknown>): NodePatch {
  const patch: NodePatch = {};
  if ("x" in body || "y" in body) Object.assign(patch, readPoint(body));
  if ("title" in body) {
    if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 80) {
      throw new RequestError(400, "节点名称需要 1 至 80 个字符");
    }
    patch.title = body.title.trim();
  }
  if (Object.keys(patch).length === 0) throw new RequestError(400, "缺少节点更新内容");
  return patch;
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = request.method;

  if (path === "/" && url.searchParams.has("doc") && (method === "GET" || method === "HEAD")) {
    response.writeHead(302, { Location: `/narrative${url.search}` }).end();
    return;
  }

  if (path === "/api/documents") {
    if (method === "GET") return json(response, 200, documents.list());
    if (method === "POST") {
      const title = readTitle((await readBody(request)).title);
      if (!title) throw new RequestError(400, "请输入文档名称");
      return json(response, 201, documents.create(title));
    }
    throw new RequestError(405, "请求方法不受支持");
  }

  const documentId = /^\/api\/documents\/([0-9a-f-]{36})$/.exec(path)?.[1];
  if (documentId) {
    if (method === "GET") {
      const document = documents.get(documentId);
      if (!document) throw new RequestError(404, "文档不存在");
      return json(response, 200, document);
    }
    if (method === "PUT") {
      const edit = readDocumentEdit(await readBody(request, 4 * 1024 * 1024));
      if (!edit) throw new RequestError(400, "文档内容无效");
      const document = documents.update(documentId, edit);
      if (document) return json(response, 200, document);
      if (!documents.get(documentId)) throw new RequestError(404, "文档不存在");
      throw new RequestError(409, "文档已在另一个页面更新。当前编辑仍保留在此页");
    }
    throw new RequestError(405, "请求方法不受支持");
  }

  if (path === "/api/nodes") {
    if (method === "GET") return json(response, 200, list.all());
    if (method === "POST") {
      const body = await readBody(request);
      const type = body.type;
      if (typeof type !== "string" || !Object.hasOwn(nodeTypes, type)) {
        throw new RequestError(400, "未知的节点类型");
      }
      const nodeType = type as CanvasNode["type"];
      const node: CanvasNode = {
        id: randomUUID(),
        type: nodeType,
        title: nodeTypes[nodeType].title,
        ...readPoint(body),
      };
      insert.run(node.id, node.type, node.title, node.x, node.y);
      return json(response, 201, node);
    }
    throw new RequestError(405, "请求方法不受支持");
  }

  const nodeId = /^\/api\/nodes\/([0-9a-f-]{36})$/.exec(path)?.[1];
  if (nodeId) {
    if (method === "PATCH") {
      const patch = readPatch(await readBody(request));
      const node = update.get(patch.title ?? null, patch.x ?? null, patch.y ?? null, nodeId);
      if (!node) throw new RequestError(404, "节点不存在");
      return json(response, 200, node);
    }
    if (method === "DELETE") {
      if (remove.run(nodeId).changes === 0) throw new RequestError(404, "节点不存在");
      response.writeHead(204).end();
      return;
    }
    throw new RequestError(405, "请求方法不受支持");
  }

  const asset = assets.get(path);
  if (asset && (method === "GET" || method === "HEAD")) {
    const content = readFileSync(resolve(root, asset.file));
    response.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "no-cache" });
    response.end(method === "HEAD" ? undefined : content);
    return;
  }
  throw new RequestError(404, "页面不存在");
}

const port = Number(process.env.PORT ?? 3000);
const server = createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    if (error instanceof RequestError) {
      json(response, error.status, { error: error.message });
    } else {
      console.error(error);
      json(response, 500, { error: "服务器无法完成此操作" });
    }
  });
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address === "object") console.log(`Local: http://127.0.0.1:${address.port}`);
});
