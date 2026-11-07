import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getSchema, type JSONContent } from "@tiptap/core";
import { Node } from "@tiptap/pm/model";
import {
  defaultDocumentStyle, documentExtensions, isDocumentBackground, isDocumentColor, isDocumentFontSize, isDocumentLineHeight, isParagraphAlignment, isParagraphSpacing,
  maxTitleLength, newSection, numberingStyles,
  type DocumentStyle, type NarrativeDocument, type NarrativeSection, type NumberingStyle, type SectionGroup,
} from "./document-model.js";

type StoredDocument = Omit<NarrativeDocument, "content"> & { content: string };

const schema = getSchema(documentExtensions);

function migrateDocuments(db: DatabaseSync) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
    if (version < 2) {
      const set = db.prepare("UPDATE documents SET content = ?, revision = revision + 1 WHERE id = ?");
      const rows = db.prepare("SELECT id, content FROM documents").all() as Pick<StoredDocument, "id" | "content">[];
      for (const row of rows) {
        const old: JSONContent = JSON.parse(row.content);
        const main = newSection(randomUUID(), "正文");
        function migrateBlock(block: JSONContent): JSONContent {
          if (block.type === "tableOfContents") {
            for (const entry of block.content ?? []) {
              const name = entry.content?.map((part) => part.text ?? "").join("").trim();
              if (!name) continue;
              const child = newSection(randomUUID(), name.slice(0, maxTitleLength));
              if (name.length > maxTitleLength) {
                child.body = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: name }] }] };
              }
              main.sections.push(child);
            }
            return { type: "paragraph" };
          }
          return block.content ? { ...block, content: block.content.map(migrateBlock) } : block;
        }
        if (old.content?.length) main.body = { type: "doc", content: old.content.map(migrateBlock) };
        const content: SectionGroup = { numbering: "decimal", sections: [main] };
        set.run(JSON.stringify(content), row.id);
      }
      db.exec("PRAGMA user_version = 2");
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function readTitle(value: unknown) {
  if (typeof value !== "string") return;
  const title = value.trim();
  if (title && title.length <= maxTitleLength) return title;
}

function readGroup(value: unknown, ids: Set<string>, depth = 0): SectionGroup {
  if (!value || typeof value !== "object" || depth > 24) throw new Error("Invalid section group");
  const { numbering, sections } = value as Record<string, unknown>;
  if (!numberingStyles.includes(numbering as NumberingStyle) || !Array.isArray(sections)) {
    throw new Error("Invalid section group");
  }
  return {
    numbering: numbering as NumberingStyle,
    sections: sections.map((section: unknown): NarrativeSection => {
      if (!section || typeof section !== "object") throw new Error("Invalid section");
      const { id, title, body, markdown } = section as Record<string, unknown>;
      const name = readTitle(title);
      if (!name || typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id) || ids.has(id) || ids.size >= 2000) {
        throw new Error("Invalid section");
      }
      ids.add(id);
      const parsed = Node.fromJSON(schema, body);
      if (parsed.type !== schema.topNodeType) throw new Error("Invalid section body");
      parsed.check();
      if (markdown !== undefined && typeof markdown !== "string") throw new Error("Invalid Markdown");
      return { id, title: name, body: parsed.toJSON(), markdown, ...readGroup(section, ids, depth + 1) };
    }),
  };
}

function readDocumentStyle(value: unknown): DocumentStyle | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object") throw new Error("Invalid document style");
  const {
    fontSize, color, lineHeight, bold, align, paddingBlock, paddingInline,
    background = defaultDocumentStyle.background,
    marginBlock = defaultDocumentStyle.marginBlock, marginInline = defaultDocumentStyle.marginInline,
  } = value as Record<string, unknown>;
  if (!isDocumentFontSize(fontSize) || !isDocumentColor(color) || !isDocumentBackground(background) || !isDocumentLineHeight(lineHeight)
    || typeof bold !== "boolean" || !isParagraphAlignment(align)
    || !isParagraphSpacing(paddingBlock) || !isParagraphSpacing(paddingInline)
    || !isParagraphSpacing(marginBlock) || !isParagraphSpacing(marginInline)) {
    throw new Error("Invalid document style");
  }
  return { fontSize, color, background, lineHeight, bold, align, paddingBlock, paddingInline, marginBlock, marginInline };
}

export function readDocumentEdit(body: Record<string, unknown>) {
  const { title, content, revision } = body;
  if (typeof title !== "string" || title.length > maxTitleLength) return;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) return;

  try {
    const group = readGroup(content, new Set());
    const style = readDocumentStyle((content as Record<string, unknown>).style);
    return { title: title.trim(), content: { ...group, style }, revision };
  } catch {
    return;
  }
}

export function openDocuments(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0
    ) STRICT;
  `);
  migrateDocuments(db);
  const fields = "id, title, content, updated_at AS updatedAt, revision";
  const list = db.prepare("SELECT id, title, updated_at AS updatedAt FROM documents ORDER BY rowid DESC");
  const get = db.prepare(`SELECT ${fields} FROM documents WHERE id = ?`);
  const insert = db.prepare("INSERT INTO documents (id, title, content, updated_at) VALUES (?, ?, ?, ?)");
  const update = db.prepare(`
    UPDATE documents SET title = ?, content = ?, updated_at = ?, revision = revision + 1
    WHERE id = ? AND revision = ? RETURNING ${fields}
  `);

  function decode(row: StoredDocument | undefined): NarrativeDocument | undefined {
    if (!row) return;
    const content: NarrativeDocument["content"] = JSON.parse(row.content);
    if (content.style) content.style = { ...defaultDocumentStyle, ...content.style };
    return { ...row, content };
  }

  return {
    list: () => list.all(),
    get: (id: string) => decode(get.get(id) as StoredDocument | undefined),
    create(title: string) {
      const document: NarrativeDocument = {
        id: randomUUID(), title, updatedAt: new Date().toISOString(), revision: 0,
        content: { numbering: "decimal", sections: [newSection(randomUUID(), "正文")] },
      };
      insert.run(document.id, document.title, JSON.stringify(document.content), document.updatedAt);
      return document;
    },
    update(id: string, edit: NonNullable<ReturnType<typeof readDocumentEdit>>) {
      const row = update.get(edit.title, JSON.stringify(edit.content), new Date().toISOString(), id, edit.revision);
      return decode(row as StoredDocument | undefined);
    },
  };
}
