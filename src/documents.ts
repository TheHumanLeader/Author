import { Editor } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { createTextContextMenu } from "./text-context-menu.js";
import { createParagraphTree, paragraphTreeHighlight } from "./paragraph-tree.js";
import { alignmentControl, applyDocumentStyle, colorControl, fontSizeControl, showStylePopover, spacingInputs } from "./style-settings.js";
import { selectControl } from "./select-control.js";
import {
  defaultDocumentStyle, documentExtensions, documentLineHeights, maxTitleLength, newSection, paragraphNodeTypes, untitled,
  type DocumentStyle, type DocumentSummary, type NarrativeDocument, type NarrativeSection, type NumberingStyle, type SectionGroup,
} from "./document-model.js";

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const editorHost = element("editor");
const textContextMenu = createTextContextMenu(() => editor);
const paragraphTree = createParagraphTree(getDocumentStyle);
const narrowWorkspace = window.matchMedia("(max-width: 650px)");
const outlineList = element("outline-list");
const retry = element<HTMLButtonElement>("retry");
const outlineToggle = element<HTMLButtonElement>("outline-toggle");
const newButton = element<HTMLButtonElement>("new-document");
const settingsButton = element<HTMLButtonElement>("document-settings");
const stylePopover = element("document-style-settings");
const fontSize = fontSizeControl("document-font-size");
const color = colorControl("document-color", "文档文字颜色");
const background = colorControl("document-background", "文档背景色", "透明");
const lineHeight = selectControl("document-line-height", documentLineHeights.map((height) => new Option(`${height} 倍`, String(height))));
const weight = selectControl("document-weight");
const alignment = alignmentControl(element("document-align"));
const padding = spacingInputs("document", "padding");
const margin = spacingInputs("document", "margin");
const dateFormat = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" });
const dialog = element<HTMLDialogElement>("name-dialog");
const nameInput = element<HTMLInputElement>("item-name");
const numberingInput = selectControl("numbering");
nameInput.maxLength = maxTitleLength;

let current: NarrativeDocument | undefined;
let editor: Editor | undefined;
let activePath: NarrativeSection[] = [];
let showOverview = true;
const collapsed = new Set<string>();
let dirty = false;
let loading = false;
let timer: number | undefined;
let pendingSave: Promise<boolean> | undefined;
let retryAction: (() => void) | undefined;
let submitName: ((name: string, numbering: NumberingStyle) => void) | undefined;

function getDocumentStyle() {
  return current?.content.style ?? defaultDocumentStyle;
}

function fillStyleSettings(style: DocumentStyle) {
  fontSize.value = String(style.fontSize);
  color.set(style.color);
  background.set(style.background);
  lineHeight.value = String(style.lineHeight);
  weight.value = style.bold ? "bold" : "normal";
  alignment.set(style.align);
  padding.block.value = String(style.paddingBlock);
  padding.inline.value = String(style.paddingInline);
  margin.block.value = String(style.marginBlock);
  margin.inline.value = String(style.marginInline);
}

function state(kind: string, message: string, action?: () => void) {
  element("save-state").dataset.state = kind;
  element("save-text").textContent = message;
  retry.hidden = !action;
  retryAction = action;
}

async function api<T>(method: string, id?: string, data?: object): Promise<T> {
  const response = await fetch(id ? `/api/documents/${id}` : "/api/documents", {
    method,
    headers: data && { "Content-Type": "application/json" },
    body: data && JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "请求失败");
  return result as T;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "请求失败";
}

function documentUrl(id: string) {
  return `/narrative?doc=${encodeURIComponent(id)}`;
}

function renderLibrary(summaries: DocumentSummary[]) {
  element("document-count").textContent = String(summaries.length);
  const list = element("document-list");
  if (summaries.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "暂无文档";
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...summaries.map((item) => {
    const link = document.createElement("a");
    link.href = documentUrl(item.id);
    link.innerHTML = '<svg aria-hidden="true"><use href="#file"/></svg><strong></strong><small></small>';
    link.querySelector("strong")!.textContent = item.title || untitled;
    link.querySelector("small")!.textContent = dateFormat.format(new Date(item.updatedAt));
    return link;
  }));
}

function action(label: string, run: () => void, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", run);
  return button;
}

const chineseDigits = "零一二三四五六七八九";
function chineseNumber(number: number): string {
  if (number < 10) return chineseDigits[number];
  const unit = number >= 1000 ? 1000 : number >= 100 ? 100 : 10;
  const first = Math.floor(number / unit);
  const rest = number % unit;
  const prefix = number < 20 ? "" : chineseDigits[first];
  const suffix = rest ? (rest < unit / 10 ? "零" : "") + chineseNumber(rest) : "";
  const restWithTens = unit > 10 && rest >= 10 && rest < 20 ? suffix.replace("十", "一十") : suffix;
  return prefix + (unit === 1000 ? "千" : unit === 100 ? "百" : "十") + restWithTens;
}

function sectionNumber(style: NumberingStyle, index: number) {
  if (style === "bullet") return "·";
  return style === "chinese" ? chineseNumber(index + 1) : String(index + 1);
}

function numberedLabel(style: NumberingStyle, index: number, title: string) {
  const label = document.createElement("span");
  label.className = "numbered-label";
  const marker = document.createElement("span");
  marker.className = "section-number";
  marker.textContent = sectionNumber(style, index);
  const name = document.createElement("span");
  name.className = "section-name";
  name.textContent = title;
  label.append(marker, name);
  return label;
}

function renderTreeGroup(group: SectionGroup, ancestors: NarrativeSection[]): HTMLUListElement {
  const list = document.createElement("ul");
  for (const [index, section] of group.sections.entries()) {
    const path = [...ancestors, section];
    const item = document.createElement("li");
    const row = document.createElement("div");
    row.className = "tree-row";
    if (section.sections.length) {
      const expanded = !collapsed.has(section.id);
      const toggle = action(expanded ? "⌄" : "›", () => {
        if (expanded) collapsed.add(section.id);
        else collapsed.delete(section.id);
        renderTree();
      }, "tree-icon");
      toggle.setAttribute("aria-label", `${expanded ? "收起" : "展开"} ${section.title}`);
      toggle.setAttribute("aria-expanded", String(expanded));
      row.append(toggle);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "tree-spacer";
      row.append(spacer);
    }

    const content = action("", () => openView(path, false), "tree-content");
    content.setAttribute("aria-label", section.title);
    content.append(numberedLabel(group.numbering, index, section.title));
    row.append(content);
    if (!showOverview && activePath.at(-1) === section) content.setAttribute("aria-current", "location");

    if (section.sections.length) {
      const overview = action("总览", () => openView(path, true), "tree-overview");
      overview.setAttribute("aria-label", `${section.title} 总览`);
      if (showOverview && activePath.at(-1) === section) overview.setAttribute("aria-current", "location");
      row.append(overview);
    }
    const add = action("+", () => addSection(path), "tree-icon tree-add");
    add.title = "添加子目录";
    add.setAttribute("aria-label", `在 ${section.title} 下添加子目录`);
    row.append(add);
    item.append(row);
    if (section.sections.length && !collapsed.has(section.id)) item.append(renderTreeGroup(section, path));
    list.append(item);
  }
  return list;
}

function renderTree() {
  if (!current) return;
  const overview = action("文档总览", () => openView([], true), "root-overview");
  if (activePath.length === 0) overview.setAttribute("aria-current", "location");
  outlineList.replaceChildren(overview, renderTreeGroup(current.content, []));
}

function renderPath() {
  if (!current) return;
  const nav = element("document-path");
  nav.replaceChildren(action(current.title || untitled, () => openView([], true)));
  for (const [index, section] of activePath.entries()) {
    const divider = document.createElement("span");
    divider.className = "path-divider";
    divider.textContent = "/";
    divider.setAttribute("aria-hidden", "true");
    nav.append(divider, action(section.title, () => openView(activePath.slice(0, index + 1), false)));
  }
  if (showOverview) {
    const currentView = document.createElement("span");
    currentView.className = "path-view";
    currentView.textContent = "总览";
    nav.append(currentView);
  }
  nav.lastElementChild?.setAttribute("aria-current", "location");
  nav.scrollLeft = nav.scrollWidth;
}

function renderOverviewGroup(group: SectionGroup, ancestors: NarrativeSection[]): HTMLUListElement {
  const list = document.createElement("ul");
  for (const [index, section] of group.sections.entries()) {
    const path = [...ancestors, section];
    const item = document.createElement("li");
    const button = action("", () => openView(path, false), "overview-item");
    button.append(numberedLabel(group.numbering, index, section.title));
    const preview = document.createElement("small");
    function collectText(block: NarrativeSection["body"]): string {
      return block.text ?? block.content?.map(collectText).join(block.type === "doc" ? " " : "") ?? "";
    }
    const text = collectText(section.body).trim();
    preview.textContent = text || "暂无正文";
    button.append(preview);
    item.append(button);
    if (section.sections.length) item.append(renderOverviewGroup(section, path));
    list.append(item);
  }
  return list;
}

function renderOverview() {
  if (!current) return;
  const group = activePath.at(-1) ?? current.content;
  const panel = element("section-overview");
  if (group.sections.length) {
    panel.replaceChildren(renderOverviewGroup(group, activePath));
    return;
  }
  const summary = document.createElement("p");
  summary.textContent = "暂无目录";
  panel.replaceChildren(summary);
}

function renderMetadata() {
  if (!current || !editor) return;
  const count = Array.from(editor.getText().replace(/\s/gu, "")).length;
  element("character-count").textContent = `${count} 字`;
  element("updated-at").textContent = `更新于 ${dateFormat.format(new Date(current.updatedAt))}`;
  editorHost.dataset.empty = String(editor.isEmpty);
}

function selectParagraph(view: EditorView, event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "a") return false;
  const { selection, doc } = view.state;
  const head = selection.$head;
  if (selection instanceof NodeSelection && paragraphNodeTypes.includes(selection.node.type.name)) {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, selection.from + 1, selection.to - 1)));
    return true;
  }
  if (!paragraphNodeTypes.includes(head.parent.type.name)) return false;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, head.start(), head.end())));
  return true;
}

function scheduleSave() {
  dirty = true;
  window.clearTimeout(timer);
  state("saving", "正在保存");
  timer = window.setTimeout(() => void flush(), 550);
}

async function saveChanges() {
  while (dirty && current) {
    const saving = current;
    dirty = false;
    state("saving", "正在保存");
    try {
      const saved = await api<NarrativeDocument>("PUT", saving.id, {
        title: saving.title, content: saving.content, revision: saving.revision,
      });
      saving.revision = saved.revision;
      saving.updatedAt = saved.updatedAt;
      renderMetadata();
    } catch (error) {
      dirty = true;
      state("error", `保存失败 · ${errorMessage(error)}`, () => void flush());
      return false;
    }
  }
  state("saved", "已保存");
  return true;
}

function flush(): Promise<boolean> {
  window.clearTimeout(timer);
  if (pendingSave) return pendingSave;
  if (!dirty) return Promise.resolve(true);
  pendingSave = saveChanges().finally(() => { pendingSave = undefined; });
  return pendingSave;
}

function renderViewHeading() {
  element("section-title").textContent = activePath.at(-1)?.title || current?.title || untitled;
}

function openView(path: NarrativeSection[], overview: boolean) {
  textContextMenu.close();
  if (stylePopover.matches(":popover-open")) stylePopover.hidePopover();
  editor?.destroy();
  editor = undefined;
  activePath = path;
  showOverview = overview;
  if (narrowWorkspace.matches) setOutlineVisible(false);
  renderPath();
  renderTree();
  renderViewHeading();

  element("content-block").hidden = overview;
  paragraphTree.show(!overview);
  element("paper-scroll").hidden = !overview;
  element("paper-scroll").scrollTop = 0;
  const section = path.at(-1);
  if (overview || !section) {
    renderOverview();
    return;
  }
  document.querySelector(".visual-scroll")!.scrollTop = 0;
  editor = new Editor({
    element: editorHost,
    extensions: [...documentExtensions, paragraphTreeHighlight],
    content: section.body,
    enableInputRules: false,
    enablePasteRules: false,
    editorProps: {
      attributes: { role: "textbox", "aria-multiline": "true", "aria-label": "目录正文", spellcheck: "false" },
      handleKeyDown: selectParagraph,
      handleDOMEvents: {
        contextmenu: (_view, event) => {
          if (!editor || !textContextMenu.open(editor, event)) return false;
          event.preventDefault();
          return true;
        },
      },
    },
    onUpdate: ({ editor }) => {
      section.body = editor.getJSON();
      paragraphTree.render(editor);
      textContextMenu.sync(editor);
      renderMetadata();
      scheduleSave();
    },
    onSelectionUpdate: ({ editor }) => textContextMenu.sync(editor),
    onTransaction: ({ editor }) => paragraphTree.sync(editor),
  });
  renderMetadata();
  paragraphTree.render(editor);
  if (editor.isEmpty) editor.commands.focus("start", { scrollIntoView: false });
}

function promptName(options: {
  heading: string;
  label: string;
  name?: string;
  numbering?: NumberingStyle;
  submit: string;
  onSubmit: (name: string, numbering: NumberingStyle) => void;
}) {
  if (dialog.open) return;
  element("dialog-title").textContent = options.heading;
  element("name-label").textContent = options.label;
  element("numbering-field").hidden = options.numbering === undefined;
  element("dialog-submit").textContent = options.submit;
  numberingInput.value = options.numbering ?? "decimal";
  nameInput.value = options.name ?? "";
  nameInput.setCustomValidity("");
  submitName = options.onSubmit;
  dialog.showModal();
  nameInput.select();
}

function addSection(parentPath: NarrativeSection[]) {
  const parent = parentPath.at(-1);
  const group = parent ?? current?.content;
  if (!group) return;
  promptName({
    heading: parent ? "添加子目录" : "添加一级目录",
    label: "目录名称", submit: "添加",
    onSubmit(name) {
      const section = newSection(crypto.randomUUID(), name);
      group.sections.push(section);
      if (parent) collapsed.delete(parent.id);
      scheduleSave();
      openView([...parentPath, section], false);
    },
  });
}

function openNameAndNumbering(section?: NarrativeSection) {
  const document = current;
  if (!document) return;
  stylePopover.hidePopover();
  const group = section ?? document.content;
  promptName({
    heading: section ? "目录设置" : "文档名称与编号",
    label: section ? "目录名称" : "文档名称",
    name: section?.title ?? document.title, numbering: group.numbering, submit: "保存",
    onSubmit(name, numbering) {
      if (section) section.title = name;
      else document.title = name;
      group.numbering = numbering;
      window.document.title = `${document.title || untitled} · Author`;
      renderTree();
      renderPath();
      renderViewHeading();
      if (showOverview) renderOverview();
      scheduleSave();
    },
  });
}

function open(document: NarrativeDocument, initialSection?: NarrativeSection) {
  current = document;
  applyDocumentStyle(editorHost, getDocumentStyle());
  window.document.title = `${document.title || untitled} · Author`;
  element("welcome").hidden = true;
  element("document").hidden = false;
  element("workspace").dataset.view = "editor";
  element("outline-panel").hidden = false;
  outlineToggle.hidden = false;
  history.replaceState(null, "", documentUrl(document.id));
  if (initialSection) openView([initialSection], false);
  else openView([], true);
  state("saved", "已保存");
}

async function createDocument(title: string) {
  if (loading) return;
  loading = true;
  newButton.disabled = true;
  try {
    state("idle", "正在创建文档");
    const document = await api<NarrativeDocument>("POST", undefined, { title });
    open(document, document.content.sections[0]);
  } catch (error) {
    state("error", errorMessage(error), () => void createDocument(title));
  } finally {
    loading = false;
    newButton.disabled = false;
  }
}

element("name-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.setCustomValidity("请输入名称");
    nameInput.reportValidity();
    return;
  }
  dialog.close();
  submitName?.(name, numberingInput.value as NumberingStyle);
});
nameInput.addEventListener("input", () => nameInput.setCustomValidity(""));
element("cancel-dialog").addEventListener("click", () => dialog.close());
element("add-root").addEventListener("click", () => addSection([]));
settingsButton.addEventListener("click", () => {
  if (!current) return;
  fillStyleSettings(getDocumentStyle());
  element("section-info").hidden = !activePath.length;
  showStylePopover(stylePopover, settingsButton, "end");
});
element("document-info").addEventListener("click", () => openNameAndNumbering());
element("section-info").addEventListener("click", () => openNameAndNumbering(activePath.at(-1)));
element("document-style-reset").addEventListener("click", () => fillStyleSettings(defaultDocumentStyle));
element("document-style-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!current) return;
  const style: DocumentStyle = {
    fontSize: Number(fontSize.value), color: color.get(), background: background.get() || "transparent", lineHeight: Number(lineHeight.value),
    bold: weight.value === "bold", align: alignment.get() ?? defaultDocumentStyle.align,
    paddingBlock: padding.block.valueAsNumber, paddingInline: padding.inline.valueAsNumber,
    marginBlock: margin.block.valueAsNumber, marginInline: margin.inline.valueAsNumber,
  };
  stylePopover.hidePopover();
  current.content.style = style;
  applyDocumentStyle(editorHost, style);
  scheduleSave();
});

function setOutlineVisible(visible: boolean) {
  element("outline-panel").hidden = !visible;
  element("workspace").dataset.outline = visible ? "open" : "closed";
  outlineToggle.setAttribute("aria-expanded", String(visible));
}

outlineToggle.addEventListener("click", () => setOutlineVisible(element("outline-panel").hidden));

newButton.addEventListener("click", () => {
  promptName({
    heading: "新建文档", label: "文档名称", submit: "创建",
    onSubmit: (name) => void createDocument(name),
  });
});
retry.addEventListener("click", () => retryAction?.());
for (const link of document.querySelectorAll<HTMLAnchorElement>(".header a")) {
  link.addEventListener("click", async (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!dirty && !pendingSave) return;
    event.preventDefault();
    if (await flush()) location.assign(link.href);
  });
}
window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void flush();
  }
});
window.addEventListener("beforeunload", (event) => {
  if (dirty || pendingSave) {
    event.preventDefault();
    event.returnValue = "";
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && dirty) void flush();
});

async function load() {
  state("idle", "正在加载");
  try {
    const requested = new URLSearchParams(location.search).get("doc");
    if (requested) open(await api<NarrativeDocument>("GET", requested));
    else {
      renderLibrary(await api<DocumentSummary[]>("GET"));
      state("idle", "本地文档");
      newButton.disabled = false;
    }
  } catch (error) {
    state("error", `无法加载文档 · ${errorMessage(error)}`, () => void load());
  }
}
void load();
