import { Extension, type Editor } from "@tiptap/core";
import type { Node as DocumentNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { defaultBorderColor, defaultQuoteColor, documentLineHeights, maxParagraphBorderWidth, maxParagraphLevel, paragraphNodeTypes, type DocumentStyle } from "./document-model.js";
import { branchEnd, planParagraphMove, type ParagraphEntry, type ParagraphPlacement } from "./paragraph-tree-move.js";
import { alignmentControl, colorControl, fontSizeControl, showStylePopover, spacingInputs } from "./style-settings.js";
import { selectControl } from "./select-control.js";

type Highlight = { position: number; className: string };
const highlightKey = new PluginKey<Highlight[]>("paragraphTreeHighlight");

export const paragraphTreeHighlight = Extension.create({
  name: "paragraphTreeHighlight",
  addProseMirrorPlugins() {
    return [new Plugin<Highlight[]>({
      key: highlightKey,
      state: {
        init: () => [],
        apply(transaction, previous) {
          const highlights = transaction.getMeta(highlightKey) as Highlight[] | undefined;
          return highlights ?? (transaction.docChanged ? [] : previous);
        },
      },
      props: {
        decorations(state) {
          const highlights = highlightKey.getState(state);
          if (!highlights?.length) return null;
          const decorations = highlights.flatMap(({ position, className }) => {
            const paragraph = state.doc.nodeAt(position);
            if (!paragraph || !paragraphNodeTypes.includes(paragraph.type.name)) return [];
            return [Decoration.node(position, position + paragraph.nodeSize, { class: className })];
          });
          return DecorationSet.create(state.doc, decorations);
        },
      },
    })];
  },
});

export function createParagraphTree(getDocumentStyle: () => DocumentStyle) {
  const tree = document.querySelector<HTMLElement>("#paragraph-tree")!;
  const count = document.querySelector<HTMLElement>("#paragraph-tree-count")!;
  const dropHint = document.querySelector<HTMLElement>("#paragraph-drop-hint")!;
  const panel = document.querySelector<HTMLElement>("#paragraph-tree-panel")!;
  const toggle = document.querySelector<HTMLButtonElement>("#paragraph-tree-toggle")!;
  const compactLayout = matchMedia("(max-width: 820px)");
  const settings = document.querySelector<HTMLElement>("#paragraph-settings")!;
  const form = document.querySelector<HTMLFormElement>("#paragraph-settings-form")!;
  const settingsPreview = document.querySelector<HTMLElement>("#paragraph-settings-target")!;
  const alignment = alignmentControl(document.querySelector<HTMLElement>("#paragraph-align")!);
  const padding = spacingInputs("paragraph", "padding");
  const margin = spacingInputs("paragraph", "margin");
  const fontSize = fontSizeControl("paragraph-font-size");
  const color = colorControl("paragraph-color", "段落文字颜色");
  const background = colorControl("paragraph-background", "段落背景色", "透明");
  const borderStyle = selectControl("paragraph-border-style");
  const borderWidth = document.querySelector<HTMLInputElement>("#paragraph-border-width")!;
  borderWidth.max = String(maxParagraphBorderWidth);
  const borderColor = colorControl("paragraph-border-color", "边框颜色");
  const quote = document.querySelector<HTMLInputElement>("#paragraph-quote")!;
  const quoteColor = colorControl("paragraph-quote-color", "引用颜色");
  const lineHeight = selectControl("paragraph-line-height", documentLineHeights.map((height) => new Option(`${height} 倍`, String(height))));
  const weight = selectControl("paragraph-weight");
  const paper = document.querySelector<HTMLElement>(".visual-scroll")!;
  const rows = new Map<number, HTMLButtonElement>();
  let active: HTMLButtonElement | undefined;
  let settingsTarget: { editor: Editor; doc: DocumentNode; position: number } | undefined;
  let restoreDefaults = false;
  let dragging: { editor: Editor; doc: DocumentNode; entry: ParagraphEntry; item: HTMLLIElement; highlights: Highlight[] } | undefined;
  let dropTarget: { row: HTMLElement; marker: HTMLElement; placement: ParagraphPlacement; allowed: boolean } | undefined;
  const dragHint = "文字区排序，「子级」改层级";
  let desktopExpanded = true;

  function clearDropTarget() {
    dropTarget?.row.removeAttribute("data-drag-target");
    dropTarget?.marker.removeAttribute("data-drop");
    dropTarget?.marker.style.removeProperty("--drop-indent");
    dropTarget = undefined;
    dropHint.textContent = dragging ? dragHint : "";
  }

  function clearDrag() {
    const editor = dragging?.editor;
    dragging?.item.removeAttribute("data-drag-source");
    dragging = undefined;
    delete panel.dataset.dragActive;
    clearDropTarget();
    if (editor) showHighlights(editor, []);
  }

  function placementAt(row: HTMLElement, childZone: HTMLElement, event: DragEvent): ParagraphPlacement {
    const zone = childZone.getBoundingClientRect();
    if (event.clientX >= zone.left && event.clientX < zone.right) return "inside";
    const bounds = row.getBoundingClientRect();
    return event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
  }

  function setExpanded(expanded: boolean) {
    panel.dataset.expanded = String(expanded);
    toggle.setAttribute("aria-expanded", String(expanded));
  }

  function showHighlights(editor: Editor, highlights: Highlight[]) {
    if (editor.isDestroyed) return;
    const previous = highlightKey.getState(editor.state);
    if (previous?.length === highlights.length && highlights.every(({ position, className }, index) => (
      previous[index].position === position && previous[index].className === className
    ))) return;
    editor.view.dispatch(editor.state.tr.setMeta(highlightKey, highlights));
  }

  function paragraphElement(editor: Editor, position: number) {
    const node = editor.view.nodeDOM(position);
    return node instanceof HTMLElement ? node : undefined;
  }

  function revealParagraph(editor: Editor, position: number) {
    const paragraph = paragraphElement(editor, position)?.getBoundingClientRect();
    if (!paragraph) return;
    const bounds = paper.getBoundingClientRect();
    if (paragraph.bottom <= bounds.top || paragraph.top >= bounds.bottom) {
      paper.scrollTop += paragraph.top - bounds.top - paper.clientHeight / 3;
    }
  }

  function captureMove(editor: Editor, entries: ParagraphEntry[]) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const surfaces = [
      { scroller: tree, elementAt: (position: number) => rows.get(position)?.closest<HTMLElement>(".paragraph-tree-row") },
      { scroller: paper, elementAt: (position: number) => paragraphElement(editor, position) },
    ];
    const snapshots = surfaces.map(({ scroller, elementAt }) => {
      const bounds = scroller.getBoundingClientRect();
      const origins = entries.flatMap(({ position }) => {
        const rect = elementAt(position)?.getBoundingClientRect();
        if (!rect) return [];
        return [{ position, x: rect.left - bounds.left, y: rect.top - bounds.top + scroller.scrollTop,
          visible: rect.bottom > bounds.top && rect.top < bounds.bottom }];
      });
      return { scroller, elementAt, origins };
    });
    return (positions: Map<number, number>) => {
      const motions = snapshots.flatMap(({ scroller, elementAt, origins }) => {
        const bounds = scroller.getBoundingClientRect();
        return origins.flatMap(({ position, x, y, visible }) => {
          const element = elementAt(positions.get(position) ?? position);
          if (!element) return [];
          const rect = element.getBoundingClientRect();
          if (!visible && (rect.bottom <= bounds.top || rect.top >= bounds.bottom)) return [];
          const dx = x - (rect.left - bounds.left);
          const dy = y - (rect.top - bounds.top + scroller.scrollTop);
          return Math.abs(dx) + Math.abs(dy) < 1 ? [] : [{ element, dx, dy }];
        });
      });
      for (const { element, dx, dy } of motions) {
        element.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0 0" }], {
          duration: 320,
          easing: "cubic-bezier(.22, .8, .25, 1)",
        });
      }
    };
  }

  function sync(editor: Editor) {
    const { $head } = editor.state.selection;
    const position = paragraphNodeTypes.includes($head.parent.type.name) ? $head.before() : undefined;
    const next = position === undefined ? undefined : rows.get(position);
    if (next === active) return;
    active?.removeAttribute("aria-current");
    active = next;
    if (!active) return;
    active.setAttribute("aria-current", "location");
    const row = active.getBoundingClientRect();
    const bounds = tree.getBoundingClientRect();
    if (row.top < bounds.top) tree.scrollTop -= bounds.top - row.top;
    else if (row.bottom > bounds.bottom) tree.scrollTop += row.bottom - bounds.bottom;
  }

  function jump(editor: Editor, position: number) {
    const paragraph = editor.state.doc.nodeAt(position);
    if (!paragraph || !paragraphNodeTypes.includes(paragraph.type.name)) return;
    showHighlights(editor, []);
    if (compactLayout.matches) setExpanded(false);
    editor.chain().setTextSelection(position + paragraph.nodeSize - 1).focus().run();
  }

  function fillSettings(attrs: DocumentNode["attrs"]) {
    const defaults = getDocumentStyle();
    alignment.set(attrs.paragraphAlign ?? defaults.align);
    padding.block.value = String(attrs.paragraphPaddingBlock ?? defaults.paddingBlock);
    padding.inline.value = String(attrs.paragraphPaddingInline ?? defaults.paddingInline);
    margin.block.value = String(attrs.paragraphMarginBlock ?? defaults.marginBlock);
    margin.inline.value = String(attrs.paragraphMarginInline ?? defaults.marginInline);
    fontSize.value = String(attrs.paragraphFontSize ?? defaults.fontSize);
    color.set(attrs.paragraphColor ?? defaults.color);
    background.set(attrs.paragraphBackground ?? defaults.background);
    borderStyle.value = attrs.paragraphBorderStyle ?? "none";
    borderWidth.value = String(attrs.paragraphBorderWidth ?? 1);
    borderColor.set(attrs.paragraphBorderColor ?? defaultBorderColor);
    quote.checked = attrs.paragraphQuote ?? false;
    quoteColor.set(attrs.paragraphQuoteColor ?? defaultQuoteColor);
    lineHeight.value = String(attrs.paragraphLineHeight ?? defaults.lineHeight);
    weight.value = (attrs.paragraphBold ?? defaults.bold) ? "bold" : "normal";
  }

  function openSettings(editor: Editor, entry: ParagraphEntry, name: string, button: HTMLButtonElement) {
    settingsTarget = { editor, doc: editor.state.doc, position: entry.position };
    restoreDefaults = false;
    settingsPreview.textContent = name;
    settingsPreview.title = name;
    fillSettings(entry.node.attrs);
    showStylePopover(settings, button, "start");
    settings.querySelector<HTMLInputElement>("input:checked")?.focus({ preventScroll: true });
  }

  function render(editor: Editor) {
    clearDrag();
    rows.clear();
    active = undefined;
    const root = document.createElement("ul");
    const parents: { item: HTMLLIElement; index: number }[] = [];
    const entries: ParagraphEntry[] = [];
    let previousLevel = -1;

    editor.state.doc.descendants((node, position) => {
      if (!paragraphNodeTypes.includes(node.type.name)) return;
      const limit = Math.min(previousLevel + 1, maxParagraphLevel);
      const level = Math.min(node.attrs.paragraphLevel ?? 0, limit);
      const parent = level > 0 ? parents[level - 1] : undefined;
      const entry = { node, position, level, index: entries.length, parentIndex: parent?.index };
      entries.push(entry);
      const preview = node.textBetween(0, node.content.size, " ", " ").trim();
      const name = preview || "空段落";
      const item = document.createElement("li");
      const row = document.createElement("div");
      row.className = "paragraph-tree-row";
      const gear = document.createElement("button");
      gear.className = "paragraph-tree-gear";
      gear.type = "button";
      gear.title = "段落设置";
      gear.setAttribute("aria-label", `第 ${entry.index + 1} 段设置`);
      gear.setAttribute("aria-haspopup", "dialog");
      gear.setAttribute("aria-controls", settings.id);
      gear.innerHTML = '<svg aria-hidden="true"><use href="#settings-icon"/></svg>';
      gear.addEventListener("click", () => openSettings(editor, entry, name, gear));

      const label = document.createElement("button");
      label.className = "paragraph-tree-label";
      if (node.type.name === "heading") label.dataset.heading = `H${node.attrs.level}`;
      label.type = "button";
      label.draggable = true;
      label.textContent = name;
      label.title = name;
      label.toggleAttribute("data-empty", !preview);
      const childZone = document.createElement("span");
      childZone.className = "paragraph-child-zone";
      childZone.textContent = "子级";
      childZone.title = "放在这里，设为此段的子段落";
      label.addEventListener("click", () => jump(editor, position));
      label.addEventListener("dragstart", (event) => {
        if (!event.dataTransfer) return;
        const highlights = entries.slice(entry.index, branchEnd(entries, entry)).map(({ position }) => ({
          position, className: "paragraph-drag-source",
        }));
        dragging = { editor, doc: editor.state.doc, entry, item, highlights };
        item.dataset.dragSource = "true";
        panel.dataset.dragActive = "true";
        dropHint.textContent = dragHint;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-author-paragraph", "move");
        showHighlights(editor, highlights);
      });
      label.addEventListener("dragend", clearDrag);
      function previewDrop(event: DragEvent) {
        if (dragging?.editor !== editor || dragging.doc !== editor.state.doc) return;
        const placement = placementAt(row, childZone, event);
        if (dropTarget?.row !== row || dropTarget.placement !== placement) {
          clearDropTarget();
          const allowed = !!planParagraphMove(dragging.doc, entries, dragging.entry, entry, placement);
          const branchRows = placement === "after" ? item.querySelectorAll<HTMLElement>(".paragraph-tree-row") : [];
          const marker = branchRows[branchRows.length - 1] ?? row;
          dropTarget = { row, marker, placement, allowed };
          if (allowed) {
            row.dataset.dragTarget = "true";
            marker.dataset.drop = placement;
            if (marker !== row) {
              marker.style.setProperty("--drop-indent", `${row.getBoundingClientRect().left - marker.getBoundingClientRect().left + 3}px`);
            }
            const targetName = Array.from(name).slice(0, 9).join("");
            const action = placement === "inside" ? "设为子段落" : placement === "before" ? "移到前面" : "移到后面";
            dropHint.textContent = `${action} · ${targetName}`;
            showHighlights(editor, [...dragging.highlights, { position, className: "paragraph-drag-target" }]);
            revealParagraph(editor, position);
          } else {
            showHighlights(editor, dragging.highlights);
            dropHint.textContent = placement !== "inside" && dragging.entry.parentIndex !== entry.parentIndex
              ? "排序限同级，改层级请拖到「子级」"
              : "此处无需移动或不可放置";
          }
        }
        if (!dropTarget.allowed) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      }
      row.addEventListener("dragenter", previewDrop);
      row.addEventListener("dragover", previewDrop);
      row.addEventListener("drop", (event) => {
        if (dragging?.editor !== editor || dragging.doc !== editor.state.doc) return;
        event.preventDefault();
        const plan = planParagraphMove(dragging.doc, entries, dragging.entry, entry, placementAt(row, childZone, event));
        clearDrag();
        if (!plan) return;
        const animate = captureMove(editor, entries);
        const transaction = editor.state.tr.replaceWith(plan.from, plan.to, plan.content);
        const paragraphEnd = transaction.doc.resolve(plan.position + 1).end();
        transaction.setSelection(TextSelection.create(transaction.doc, paragraphEnd));
        editor.view.dispatch(transaction);
        revealParagraph(editor, plan.position);
        if (animate) animate(plan.mapParagraphPositions());
        editor.commands.focus(undefined, { scrollIntoView: false });
      });
      row.addEventListener("pointerenter", () => {
        if (!dragging) showHighlights(editor, [{ position, className: "paragraph-tree-highlight" }]);
      });
      row.addEventListener("pointerleave", () => {
        if (!dragging) showHighlights(editor, []);
      });
      row.append(gear, label, childZone);
      item.append(row);
      rows.set(position, label);

      if (!parent) root.append(item);
      else {
        let children = parent.item.querySelector<HTMLUListElement>(":scope > ul");
        if (!children) {
          children = document.createElement("ul");
          parent.item.append(children);
        }
        children.append(item);
      }
      parents[level] = { item, index: entry.index };
      previousLevel = level;
      return false;
    });

    count.hidden = entries.length === 0;
    count.textContent = String(entries.length);
    count.title = `共 ${entries.length} 段`;
    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "paragraph-tree-empty";
      empty.textContent = "暂无段落";
      tree.replaceChildren(empty);
    } else {
      tree.replaceChildren(root);
    }
    sync(editor);
  }

  toggle.addEventListener("click", () => {
    const expanded = panel.dataset.expanded !== "true";
    if (!compactLayout.matches) desktopExpanded = expanded;
    setExpanded(expanded);
  });
  compactLayout.addEventListener("change", () => setExpanded(!toggle.hidden && !compactLayout.matches && desktopExpanded));
  document.querySelector("#paragraph-style-reset")!.addEventListener("click", () => {
    restoreDefaults = true;
    fillSettings({});
  });
  tree.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Node && tree.contains(event.relatedTarget)) return;
    clearDropTarget();
    if (dragging) showHighlights(dragging.editor, dragging.highlights);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!settingsTarget) return;
    const { editor, doc, position } = settingsTarget;
    settings.hidePopover();
    if (editor.isDestroyed || editor.state.doc !== doc) return;
    const paragraph = doc.nodeAt(position);
    if (!paragraph) return;
    const style = getDocumentStyle();
    const defaults = { ...style, color: style.color.toLowerCase(), background: style.background.toLowerCase() };
    const previous = restoreDefaults ? {} : paragraph.attrs;
    // Keep an existing override that happens to match a later document default.
    function override<K extends keyof DocumentStyle>(key: K, value: DocumentStyle[K], saved: unknown) {
      return value !== defaults[key] || saved === value ? value : null;
    }
    const attrs = {
      ...paragraph.attrs,
      paragraphAlign: override("align", alignment.get() ?? defaults.align, previous.paragraphAlign),
      paragraphPaddingBlock: override("paddingBlock", padding.block.valueAsNumber, previous.paragraphPaddingBlock),
      paragraphPaddingInline: override("paddingInline", padding.inline.valueAsNumber, previous.paragraphPaddingInline),
      paragraphMarginBlock: override("marginBlock", margin.block.valueAsNumber, previous.paragraphMarginBlock),
      paragraphMarginInline: override("marginInline", margin.inline.valueAsNumber, previous.paragraphMarginInline),
      paragraphFontSize: override("fontSize", Number(fontSize.value), previous.paragraphFontSize),
      paragraphColor: override("color", color.get(), previous.paragraphColor?.toLowerCase()),
      paragraphBackground: override("background", background.get() || "transparent", previous.paragraphBackground?.toLowerCase()),
      paragraphBorderStyle: borderStyle.value === "none" ? null : borderStyle.value,
      paragraphBorderWidth: borderWidth.valueAsNumber === 1 ? null : borderWidth.valueAsNumber,
      paragraphBorderColor: borderColor.get() === defaultBorderColor ? null : borderColor.get(),
      paragraphQuote: quote.checked,
      paragraphQuoteColor: quoteColor.get() === defaultQuoteColor ? null : quoteColor.get(),
      paragraphLineHeight: override("lineHeight", Number(lineHeight.value), previous.paragraphLineHeight),
      paragraphBold: override("bold", weight.value === "bold", previous.paragraphBold),
    };
    if (!paragraph.hasMarkup(paragraph.type, attrs)) {
      editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, attrs));
    }
    editor.view.focus();
  });

  return {
    render,
    sync,
    show(visible: boolean) {
      clearDrag();
      toggle.hidden = !visible;
      if (settings.matches(":popover-open")) settings.hidePopover();
      settingsTarget = undefined;
      setExpanded(visible && !compactLayout.matches && desktopExpanded);
      if (visible) tree.scrollTop = 0;
      else {
        rows.clear();
        active = undefined;
        tree.replaceChildren();
      }
    },
  };
}
