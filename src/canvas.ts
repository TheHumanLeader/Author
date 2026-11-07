import { nodeTypes, type CanvasNode, type NodePatch, type NodeType, type Point } from "./model.js";

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const canvas = element("canvas");
const world = element("world");
const palette = element("palette");
const nodeList = element("node-list");
const quickAdd = element<HTMLButtonElement>("quick-add");
const selectTool = element<HTMLButtonElement>("select");
const panTool = element<HTMLButtonElement>("pan");
const zoomIn = element<HTMLButtonElement>("zoom-in");
const zoomOut = element<HTMLButtonElement>("zoom-out");
const nodes = new Map<string, NodeView>();
const viewport = { x: 0, y: 0, scale: 1 };

interface NodeView {
  data: CanvasNode;
  card: HTMLElement;
  title: HTMLElement;
  row: HTMLButtonElement;
  rowTitle: HTMLElement;
  deleteButton: HTMLButtonElement;
  busy: boolean;
}

interface Drag {
  pointerId: number;
  start: Point;
  origin: Point;
  node?: NodeView;
  moved: boolean;
}

let ready = false;
let placing: NodeType | undefined;
let tool: "select" | "pan" = "select";
let spaceHeld = false;
let selected: NodeView | undefined;
let drag: Drag | undefined;
let saving = 0;

function icon(name: string) {
  return `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function status(state: string, message: string) {
  element("status").dataset.state = state;
  element("status-text").textContent = message;
}

async function request<T>(method: string, id?: string, body?: object): Promise<T> {
  const response = await fetch(id ? `/api/nodes/${id}` : "/api/nodes", {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data as T;
}

async function save<T>(operation: () => Promise<T>): Promise<T | undefined> {
  if (saving++ === 0 || element("status").dataset.state !== "error") status("saving", "正在保存");
  try {
    return await operation();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "请重试";
    status("error", `保存失败 · ${detail}`);
  } finally {
    if (--saving === 0 && element("status").dataset.state !== "error") status("saved", "已保存到本地");
  }
}

function screenCenter(): Point {
  return { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
}

function canvasPoint(event: MouseEvent): Point {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function worldPoint(point: Point): Point {
  return { x: (point.x - viewport.x) / viewport.scale, y: (point.y - viewport.y) / viewport.scale };
}

function renderViewport() {
  const { x, y, scale } = viewport;
  world.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  const grid = 24 * scale * (scale < 0.5 ? 4 : scale < 0.75 ? 2 : 1);
  canvas.style.setProperty("--grid", `${grid}px`);
  canvas.style.setProperty("--grid-x", `${(x - grid / 2) % grid}px`);
  canvas.style.setProperty("--grid-y", `${(y - grid / 2) % grid}px`);
  element("zoom").textContent = `${Math.round(scale * 100)}%`;
  zoomOut.disabled = scale <= 0.25;
  zoomIn.disabled = scale >= 2.5;
}

function zoomAt(point: Point, factor: number) {
  if (drag) return;
  const anchor = worldPoint(point);
  viewport.scale = Math.min(2.5, Math.max(0.25, viewport.scale * factor));
  viewport.x = point.x - anchor.x * viewport.scale;
  viewport.y = point.y - anchor.y * viewport.scale;
  renderViewport();
}

function centerOn(point: Point, scale = viewport.scale) {
  const center = screenCenter();
  Object.assign(viewport, { x: center.x - point.x * scale, y: center.y - point.y * scale, scale });
  renderViewport();
}

function activeMode() {
  return spaceHeld ? "pan" : placing ? "place" : tool;
}

function renderMode() {
  const mode = activeMode();
  canvas.dataset.mode = mode;
  element("placement").hidden = mode !== "place";
  selectTool.setAttribute("aria-pressed", String(mode === "select"));
  panTool.setAttribute("aria-pressed", String(mode === "pan"));
  for (const button of palette.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.type === placing));
  }
}

function renderCount() {
  element("node-count").textContent = String(nodes.size);
  element("empty").hidden = !ready || nodes.size > 0;
  element("list-empty").hidden = nodes.size > 0;
}

function select(node?: NodeView) {
  selected?.card.classList.remove("selected");
  selected?.row.removeAttribute("aria-current");
  selected = node;
  selected?.card.classList.add("selected");
  selected?.row.setAttribute("aria-current", "true");
}

function positionNode(view: NodeView, { x, y }: Point) {
  view.card.style.left = `${x}px`;
  view.card.style.top = `${y}px`;
}

function renderNode(view: NodeView) {
  positionNode(view, view.data);
  view.title.textContent = view.data.title;
  view.title.title = view.data.title;
  view.rowTitle.textContent = view.data.title;
  view.card.setAttribute("aria-label", view.data.title);
}

function addView(data: CanvasNode) {
  const card = document.createElement("article");
  card.className = "node";
  card.dataset.id = data.id;
  card.tabIndex = 0;
  card.innerHTML = `
    <span class="type-icon">${icon("node")}</span>
    <span class="node-title"></span>
    <button class="icon-button delete" type="button" aria-label="删除节点" title="删除节点">${icon("trash")}</button>
  `;

  const row = document.createElement("button");
  row.className = "node-row";
  row.innerHTML = `${icon("node")}<span></span>`;
  const view: NodeView = {
    data, card, row, busy: false,
    title: card.querySelector(".node-title")!,
    rowTitle: row.querySelector("span")!,
    deleteButton: card.querySelector("button")!,
  };

  card.addEventListener("focusin", () => select(view));
  card.addEventListener("dblclick", (event) => {
    if (!(event.target as Element).closest("button, input")) editTitle(view);
  });
  row.addEventListener("click", () => {
    tool = "select";
    placing = undefined;
    renderMode();
    centerOn(view.data);
    view.card.focus({ preventScroll: true });
  });
  view.deleteButton.addEventListener("click", () => void deleteNode(view));

  nodes.set(data.id, view);
  renderNode(view);
  world.append(card);
  nodeList.append(row);
  renderCount();
  return view;
}

async function createNode(type: NodeType, point: Point) {
  if (!ready) return;
  const node = await save(() => request<CanvasNode>("POST", undefined, { type, ...point }));
  if (!node) return;
  const view = addView(node);
  view.card.focus({ preventScroll: true });
}

async function updateNode(view: NodeView, patch: NodePatch) {
  view.busy = view.deleteButton.disabled = true;
  const data = await save(() => request<CanvasNode>("PATCH", view.data.id, patch));
  if (data) view.data = data;
  renderNode(view);
  view.busy = view.deleteButton.disabled = false;
}

async function deleteNode(view: NodeView) {
  if (view.busy || drag?.node === view || view.card.querySelector("input")) return;
  view.busy = view.deleteButton.disabled = true;
  const deleted = await save(async () => {
    await request<void>("DELETE", view.data.id);
    return true;
  });
  if (deleted) {
    if (selected === view) select();
    view.card.remove();
    view.row.remove();
    nodes.delete(view.data.id);
    renderCount();
  } else {
    view.busy = view.deleteButton.disabled = false;
  }
}

function editTitle(view: NodeView) {
  if (view.busy || view.card.querySelector("input")) return;
  const input = document.createElement("input");
  input.value = view.data.title;
  input.maxLength = 80;
  input.setAttribute("aria-label", "节点名称");
  view.title.hidden = true;
  view.title.after(input);

  let cancelled = false;
  input.addEventListener("blur", () => {
    const title = input.value.trim();
    input.remove();
    view.title.hidden = false;
    if (!cancelled && title && title !== view.data.title) void updateNode(view, { title });
  }, { once: true });
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape" || event.key === "Enter") {
      cancelled = event.key === "Escape";
      view.card.focus({ preventScroll: true });
    }
  });
  input.focus({ preventScroll: true });
  input.select();
}

function setTool(next: typeof tool) {
  tool = next;
  placing = undefined;
  renderMode();
}

canvas.addEventListener("pointerdown", (event) => {
  if (drag || ![0, 1].includes(event.button)) return;
  const target = event.target as Element;
  if (target.closest("button, input, .canvas-tools")) return;
  const mode = event.button === 1 ? "pan" : activeMode();
  if (mode === "place" && placing) {
    const type = placing;
    setTool("select");
    void createNode(type, worldPoint(canvasPoint(event)));
    return;
  }

  const card = mode === "select" ? target.closest<HTMLElement>(".node") : null;
  const view = card ? nodes.get(card.dataset.id!) : undefined;
  if (view?.busy || view?.card.querySelector("input")) return;
  if (view) view.card.focus({ preventScroll: true });
  else if (mode === "select") select();
  const origin = view?.data ?? viewport;
  drag = {
    pointerId: event.pointerId,
    start: canvasPoint(event),
    origin: { x: origin.x, y: origin.y },
    node: view,
    moved: false,
  };
  (card ?? canvas).setPointerCapture(event.pointerId);
  if (event.button === 1) event.preventDefault();
});

canvas.addEventListener("pointermove", (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const point = canvasPoint(event);
  const dx = point.x - drag.start.x;
  const dy = point.y - drag.start.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  canvas.dataset.dragging = "true";
  if (drag.node) {
    positionNode(drag.node, { x: drag.origin.x + dx / viewport.scale, y: drag.origin.y + dy / viewport.scale });
  } else {
    viewport.x = drag.origin.x + dx;
    viewport.y = drag.origin.y + dy;
    renderViewport();
  }
});

function endDrag(event: PointerEvent) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  const { start, node, origin, moved } = drag;
  drag = undefined;
  delete canvas.dataset.dragging;
  if (!node || !moved) return;
  if (event.type !== "pointerup") {
    positionNode(node, node.data);
    return;
  }
  const point = canvasPoint(event);
  const position = {
    x: origin.x + (point.x - start.x) / viewport.scale,
    y: origin.y + (point.y - start.y) / viewport.scale,
  };
  positionNode(node, position);
  void updateNode(node, position);
}
for (const event of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
  canvas.addEventListener(event, endDrag);
}

canvas.addEventListener("dblclick", (event) => {
  if (activeMode() === "select" && !(event.target as Element).closest(".node, .canvas-tools")) {
    void createNode("basic", worldPoint(canvasPoint(event)));
  }
});

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
  zoomAt(canvasPoint(event), Math.exp(-delta * 0.0015));
}, { passive: false });

window.addEventListener("keydown", (event) => {
  if ((event.target as Element).closest("input")) return;
  if (event.code === "Space" && !(event.target as Element).closest("button")) {
    event.preventDefault();
    spaceHeld = true;
    renderMode();
  }
  if (event.key === "Escape") setTool("select");
  if (selected && event.key === "Delete") void deleteNode(selected);
  if (selected && event.key === "F2") {
    event.preventDefault();
    editTitle(selected);
  }
});

function releaseSpace() {
  if (!spaceHeld) return;
  spaceHeld = false;
  renderMode();
}

window.addEventListener("keyup", (event) => {
  if (event.code === "Space") releaseSpace();
});
window.addEventListener("blur", releaseSpace);
selectTool.addEventListener("click", () => setTool("select"));
panTool.addEventListener("click", () => setTool("pan"));
zoomIn.addEventListener("click", () => zoomAt(screenCenter(), 1.25));
zoomOut.addEventListener("click", () => zoomAt(screenCenter(), 0.8));
element("reset").addEventListener("click", () => centerOn({ x: 0, y: 0 }, 1));
quickAdd.addEventListener("click", () => {
  setTool("select");
  const center = worldPoint(screenCenter());
  const occupied = new Set(Array.from(nodes.values(), ({ data }) => `${Math.round(data.x)},${Math.round(data.y)}`));
  while (occupied.has(`${Math.round(center.x)},${Math.round(center.y)}`)) {
    center.x += 20;
    center.y += 20;
  }
  void createNode("basic", center);
});

for (const [type, definition] of Object.entries(nodeTypes)) {
  const button = document.createElement("button");
  button.dataset.type = type;
  button.disabled = true;
  button.innerHTML = `
    <span class="type-icon">${icon("node")}</span>
    <span class="type-copy"><strong></strong><small></small></span>
    <svg class="add-icon" aria-hidden="true"><use href="#i-plus"/></svg>
  `;
  button.querySelector("strong")!.textContent = definition.title;
  button.querySelector("small")!.textContent = definition.description;
  button.addEventListener("click", () => {
    tool = "select";
    placing = placing === type ? undefined : type as NodeType;
    renderMode();
  });
  palette.append(button);
}

const emptyList = document.createElement("p");
emptyList.id = "list-empty";
emptyList.className = "list-empty";
emptyList.textContent = "暂无节点";
nodeList.append(emptyList);
centerOn({ x: 0, y: 0 });
renderMode();

try {
  for (const node of await request<CanvasNode[]>("GET")) addView(node);
  ready = true;
  quickAdd.disabled = false;
  for (const button of palette.querySelectorAll("button")) button.disabled = false;
  renderCount();
  status("saved", "已保存到本地");
} catch {
  status("error", "无法加载画布 · 请刷新页面重试");
}
