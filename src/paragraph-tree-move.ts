import { Fragment, type Node as DocumentNode } from "@tiptap/pm/model";
import { maxParagraphLevel } from "./document-model.js";

export interface ParagraphEntry {
  node: DocumentNode;
  position: number;
  level: number;
  index: number;
  parentIndex?: number;
}

export type ParagraphPlacement = "before" | "inside" | "after";

export function branchEnd(entries: ParagraphEntry[], root: ParagraphEntry) {
  let end = root.index + 1;
  while (end < entries.length && entries[end].level > root.level) end++;
  return end;
}

export function planParagraphMove(
  doc: DocumentNode,
  entries: ParagraphEntry[],
  source: ParagraphEntry,
  target: ParagraphEntry,
  placement: ParagraphPlacement,
) {
  const end = branchEnd(entries, source);
  if (target.index >= source.index && target.index < end) return;
  if (placement !== "inside" && source.parentIndex !== target.parentIndex) return;
  const branch = entries.slice(source.index, end);
  const level = target.level + (placement === "inside" ? 1 : 0);
  const delta = level - source.level;
  if (branch.some((entry) => entry.level + delta > maxParagraphLevel)) return;

  const sourcePosition = doc.resolve(source.position);
  const parentStart = sourcePosition.start();
  if (doc.resolve(target.position).start() !== parentStart) return;
  const anchor = placement === "before" ? target : entries[branchEnd(entries, target) - 1];
  const anchorPosition = doc.resolve(anchor.position);
  if (anchorPosition.start() !== parentStart) return;

  const moving = new Map<number, DocumentNode>();
  for (const entry of branch) {
    const position = doc.resolve(entry.position);
    if (position.start() !== parentStart) return;
    moving.set(position.index(), entry.node.type.create(
      { ...entry.node.attrs, paragraphLevel: entry.level + delta }, entry.node.content, entry.node.marks,
    ));
  }

  const parent = sourcePosition.parent;
  const boundary = anchorPosition.index() + (placement === "before" ? 0 : 1);
  const children: { node: DocumentNode; index: number }[] = [];
  const originalStarts: number[] = [];
  let insertionIndex = 0;
  parent.forEach((node, offset, index) => {
    originalStarts[index] = parentStart + offset;
    if (moving.has(index)) return;
    if (index < boundary) insertionIndex++;
    children.push({ node, index });
  });

  const moved = Array.from(moving, ([index, node]) => ({ index, node }));
  const position = children.slice(0, insertionIndex).reduce((offset, { node }) => offset + node.nodeSize, parentStart);
  children.splice(insertionIndex, 0, ...moved);

  const content = Fragment.fromArray(children.map(({ node }) => node));
  if (!parent.type.validContent(content) || content.eq(parent.content)) return;
  const parentEnd = sourcePosition.end();
  return {
    from: parentStart,
    to: parentEnd,
    content,
    position,
    mapParagraphPositions() {
      const newStarts: number[] = [];
      let offset = parentStart;
      for (const { index, node } of children) {
        newStarts[index] = offset;
        offset += node.nodeSize;
      }
      return new Map(entries.map(({ position }) => {
        if (position < parentStart || position >= parentEnd) return [position, position];
        const index = doc.resolve(position).index(sourcePosition.depth);
        return [position, position + newStarts[index] - originalStarts[index]];
      }));
    },
  };
}
