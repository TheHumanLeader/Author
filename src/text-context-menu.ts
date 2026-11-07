import type { Editor, ChainedCommands } from "@tiptap/core";
import type { Node as DocumentNode } from "@tiptap/pm/model";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { headingLevels, paragraphNodeTypes } from "./document-model.js";
import { colorControl, fontSizeControl } from "./style-settings.js";
import { selectControl } from "./select-control.js";

interface MenuSession {
  editor: Editor;
  selection: TextSelection;
  point?: { x: number; y: number };
}

function selectedBlocks(doc: DocumentNode, from: number, to: number) {
  const blocks: { node: DocumentNode; position: number; parent: DocumentNode; index: number }[] = [];
  doc.nodesBetween(from, to, (node, position, parent, index) => {
    if (!node.isTextblock) return;
    if (parent && paragraphNodeTypes.includes(node.type.name)) blocks.push({ node, position, parent, index });
    return false;
  });
  return blocks;
}

function clearInlineFontSizes(tr: Transaction, block: DocumentNode, position: number) {
  const textStyle = tr.doc.type.schema.marks.textStyle;
  block.descendants((node, offset) => {
    const mark = textStyle.isInSet(node.marks);
    if (mark?.attrs.fontSize == null) return;
    const from = position + 1 + offset;
    const to = from + node.nodeSize;
    const attrs = { ...mark.attrs, fontSize: null };
    tr.removeMark(from, to, mark);
    if (Object.values(attrs).some(Boolean)) tr.addMark(from, to, textStyle.create(attrs));
  });
}

export function createTextContextMenu(getEditor: () => Editor | undefined) {
  const menu = document.querySelector<HTMLElement>("#text-context-menu")!;
  const color = colorControl("context-color", "选中文字颜色", "默认", (value) => {
    edit((chain) => value ? chain.setColor(value) : chain.unsetColor(), "keep-open");
  });
  const size = fontSizeControl("context-size", true);
  const mixedHeading = new Option("段落类型", "", false, false);
  mixedHeading.disabled = true;
  const headingOptions = headingLevels.map((level) => new Option(`H${level}`, String(level)));
  const heading = selectControl("context-heading", [mixedHeading, new Option("正文", "paragraph"), ...headingOptions]);
  const linkForm = menu.querySelector<HTMLFormElement>("#context-link-form")!;
  const linkInput = menu.querySelector<HTMLInputElement>("#context-link")!;
  const linkLabel = menu.querySelector<HTMLElement>("#context-link-label")!;
  const copyLink = menu.querySelector<HTMLButtonElement>('[data-context="copy-link"]')!;
  const removeLink = menu.querySelector<HTMLButtonElement>('[data-context="remove-link"]')!;
  const styles = Array.from(menu.querySelectorAll<HTMLButtonElement>("[data-style]"));
  const note = document.querySelector<HTMLElement>("#clipboard-note")!;
  let session: MenuSession | undefined;
  let noteTimer: number | undefined;
  let selectionFrame = 0;
  let selectingPointer: number | undefined;

  function showNote(message: string) {
    window.clearTimeout(noteTimer);
    note.textContent = message;
    note.hidden = false;
    noteTimer = window.setTimeout(() => { note.hidden = true; }, 2800);
  }

  function positionMenu() {
    if (!session || !valid(session)) return;
    const { editor, selection, point } = session;
    const start = editor.view.coordsAtPos(selection.from, 1);
    const end = editor.view.coordsAtPos(selection.to, -1);
    const top = Math.min(start.top, end.top);
    const bottom = Math.max(start.bottom, end.bottom);
    const viewport = editor.view.dom.closest(".visual-scroll")?.getBoundingClientRect();
    if (viewport && (bottom <= viewport.top || top >= viewport.bottom)) {
      close();
      return;
    }
    const { width, height } = menu.getBoundingClientRect();
    const x = point?.x ?? Math.min(start.left, end.left);
    const below = Math.min(bottom, viewport?.bottom ?? innerHeight) + 6;
    const above = Math.max(top, viewport?.top ?? 0) - height - 6;
    const y = point?.y ?? (below + height > innerHeight - 8 && above >= 8 ? above : below);
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
  }

  function close(restoreFocus = false) {
    cancelAnimationFrame(selectionFrame);
    const previous = session;
    session = undefined;
    menu.hidden = true;
    if (restoreFocus && previous && !previous.editor.isDestroyed) previous.editor.view.focus();
  }

  function valid(target: MenuSession) {
    return target === session && !target.editor.isDestroyed
      && target.selection.$from.doc === target.editor.state.doc;
  }

  function edit(command: (chain: ChainedCommands) => ChainedCommands, after: "close" | "keep-open" = "close") {
    if (!session || !valid(session)) return;
    const { editor, selection, point } = session;
    if (after === "close") close();
    command(editor.chain().setTextSelection(selection).focus(undefined, { scrollIntoView: false })).run();
    cancelAnimationFrame(selectionFrame);
    if (after === "keep-open" && !show(editor, point)) close();
  }

  function show(editor: Editor, point?: MenuSession["point"]) {
    const { selection } = editor.state;
    if (!(selection instanceof TextSelection) || selection.empty) return false;
    session = { editor, selection, point };
    const { color: currentColor, fontSize } = editor.getAttributes("textStyle");
    color.set(currentColor ?? "");
    size.value = typeof fontSize === "string" ? fontSize.replace(/px$/, "") : "";
    if (size.selectedIndex < 0) size.value = "";
    const blocks = selectedBlocks(editor.state.doc, selection.from, selection.to);
    const blockKinds = new Set(blocks.map(({ node }) => node.type.name === "heading" ? String(node.attrs.level) : "paragraph"));
    heading.value = blockKinds.size === 1 ? [...blockKinds][0] : "";
    heading.disabled = !blocks.length;
    const canSetHeading = blocks.every(({ node, parent, index }) => parent.canReplaceWith(index, index + 1, editor.schema.nodes.heading, node.marks));
    for (const option of headingOptions) option.disabled = !canSetHeading;
    for (const button of styles) {
      button.setAttribute("aria-pressed", String(editor.isActive(button.dataset.style!)));
    }
    const href = editor.getAttributes("link").href;
    linkLabel.textContent = href ? "编辑链接" : "添加链接";
    copyLink.hidden = !href;
    linkForm.hidden = true;
    menu.hidden = false;
    positionMenu();
    return true;
  }

  function open(editor: Editor, event: MouseEvent) {
    const point = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined;
    if (!show(editor, point)) return false;
    if (session) styles[0]?.focus({ preventScroll: true });
    return true;
  }

  function sync(editor: Editor) {
    cancelAnimationFrame(selectionFrame);
    // Wait for the editor to render the selection before measuring it.
    selectionFrame = requestAnimationFrame(() => {
      if (editor.isDestroyed || selectingPointer !== undefined || menu.contains(document.activeElement)) return;
      const { from, to } = editor.state.selection;
      if (!editor.view.hasFocus() || !editor.state.doc.textBetween(from, to) || !show(editor)) close();
    });
  }

  async function copySelection(target: MenuSession) {
    const { text, dom } = target.editor.view.serializeForClipboard(target.selection.content());
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": new Blob([dom.innerHTML], { type: "text/html" }),
      })]);
    } catch {
      await navigator.clipboard.writeText(text);
    }
  }

  async function pasteSelection(target: MenuSession) {
    let html = "";
    let text = "";
    if (typeof navigator.clipboard.read === "function") {
      for (const item of await navigator.clipboard.read()) {
        if (!html && item.types.includes("text/html")) html = await (await item.getType("text/html")).text();
        if (!text && item.types.includes("text/plain")) text = await (await item.getType("text/plain")).text();
      }
    } else {
      text = await navigator.clipboard.readText();
    }

    if (!valid(target)) return;
    const { view } = target.editor;
    view.dispatch(view.state.tr.setSelection(target.selection));
    if (html) view.pasteHTML(html);
    else if (text) view.pasteText(text);
    else showNote("剪贴板里没有可粘贴的文字");
  }

  async function clipboardAction(name: string) {
    const target = session;
    if (!target || !valid(target)) return;
    try {
      if (name === "copy") await copySelection(target);
      if (name === "paste") await pasteSelection(target);
      if (name === "copy-link") {
        const href = target.editor.getAttributes("link").href;
        if (typeof href === "string") {
          await navigator.clipboard.writeText(href);
          showNote("链接已复制");
        }
      }
    } catch {
      const shortcut = name === "paste" ? "Ctrl+V" : "Ctrl+C";
      showNote(name === "copy-link" ? "无法复制链接，可在编辑链接中复制地址" : `请按 ${shortcut} 使用剪贴板`);
    } finally {
      if (session === target) close(true);
    }
  }

  function openLink() {
    if (!session || !valid(session)) return;
    const href = session.editor.getAttributes("link").href;
    linkInput.value = href ?? "";
    linkInput.setCustomValidity("");
    removeLink.hidden = !href;
    linkForm.hidden = false;
    positionMenu();
    linkInput.focus({ preventScroll: true });
    linkInput.select();
  }

  for (const button of styles) {
    button.addEventListener("click", () => edit((chain) => chain.toggleMark(button.dataset.style!), "keep-open"));
  }
  size.onChange(() => edit((chain) => size.value ? chain.setFontSize(`${size.value}px`) : chain.unsetFontSize(), "keep-open"));
  heading.onSelect(() => {
    const level = headingLevels.find((level) => String(level) === heading.value);
    edit((chain) => chain.command(({ tr }) => {
      const { from, to, anchor, head } = tr.selection;
      const nodes = tr.doc.type.schema.nodes;
      const type = level === undefined ? nodes.paragraph : nodes.heading;
      const blocks = selectedBlocks(tr.doc, from, to);
      if (!blocks.length || blocks.some(({ node, parent, index }) => !parent.canReplaceWith(index, index + 1, type, node.marks))) return false;
      for (const { node, position } of blocks) {
        const attrs = level === undefined ? node.attrs : { ...node.attrs, level, paragraphFontSize: null };
        if (!node.hasMarkup(type, attrs)) tr.setNodeMarkup(position, type, attrs);
        if (level !== undefined) clearInlineFontSizes(tr, node, position);
      }
      tr.setSelection(TextSelection.create(tr.doc, anchor, head));
      return true;
    }), "keep-open");
  });
  menu.querySelectorAll<HTMLButtonElement>("[data-context]").forEach((button) => {
    button.addEventListener("click", () => {
      const name = button.dataset.context!;
      if (name === "link") openLink();
      else if (name === "remove-link") edit((chain) => chain.unsetLink());
      else void clipboardAction(name);
    });
  });
  linkInput.addEventListener("input", () => linkInput.setCustomValidity(""));
  linkForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = linkInput.value.trim();
    const href = /^[a-z][a-z\d+.-]*:/i.test(value) || /^[\/#]/.test(value) ? value : `https://${value}`;
    try {
      const url = new URL(href, location.origin);
      if (!["https:", "http:", "mailto:", "tel:"].includes(url.protocol)) throw new Error();
    } catch {
      linkInput.setCustomValidity("请输入有效的链接地址");
      linkInput.reportValidity();
      return;
    }
    edit((chain) => chain.setLink({ href }));
  });

  menu.addEventListener("mousedown", (event) => {
    if (event.target instanceof Element && event.target.closest("button")) event.preventDefault();
  });
  window.addEventListener("pointerdown", (event) => {
    if (!(event.target instanceof Node) || menu.contains(event.target)) return;
    close();
    const editor = getEditor();
    if (event.button === 0 && editor?.view.dom.contains(event.target)) selectingPointer = event.pointerId;
  }, true);
  function finishSelection(event: PointerEvent) {
    if (selectingPointer !== event.pointerId) return;
    selectingPointer = undefined;
    const editor = getEditor();
    if (editor) sync(editor);
  }
  window.addEventListener("pointerup", finishSelection, true);
  window.addEventListener("pointercancel", finishSelection, true);
  window.addEventListener("focusin", (event) => {
    if (!session || !(event.target instanceof Node) || menu.contains(event.target)) return;
    if (!session.editor.view.dom.contains(event.target)) close();
  });
  window.addEventListener("keydown", (event) => {
    if (session && event.key === "Escape") {
      event.preventDefault();
      close(true);
    }
  });
  window.addEventListener("resize", positionMenu);
  window.addEventListener("scroll", (event) => {
    if (event.target instanceof Node && menu.contains(event.target)) return;
    positionMenu();
  }, true);
  return { open, close, sync };
}
