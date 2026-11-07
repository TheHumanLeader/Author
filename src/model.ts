export const nodeTypes = {
  basic: { title: "普通节点", description: "在画布上放置一张空白卡片" },
} as const;

export type NodeType = keyof typeof nodeTypes;

export interface Point {
  x: number;
  y: number;
}

export interface CanvasNode extends Point {
  id: string;
  type: NodeType;
  title: string;
}

export type NodePatch = Partial<Pick<CanvasNode, "x" | "y" | "title">>;
