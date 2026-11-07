import {
  hexColor, isDocumentColor, maxFontSize, maxParagraphSpacing, minFontSize,
  paragraphAlignments, type DocumentStyle, type ParagraphAlignment,
} from "./document-model.js";
import { selectControl } from "./select-control.js";

const alignmentLabels: Record<ParagraphAlignment, string> = {
  left: "左对齐", center: "居中", right: "右对齐", justify: "两端对齐",
};

export function fontSizeControl(id: string, allowDefault = false) {
  const options = Array.from({ length: maxFontSize - minFontSize + 1 }, (_, index) => {
    const size = String(minFontSize + index);
    return new Option(`${size} px`, size);
  });
  if (allowDefault) options.unshift(new Option("默认", ""));
  return selectControl(id, options);
}

export function colorControl(id: string, label: string, emptyLabel?: string, onChange?: (value: string) => void) {
  const control = document.getElementById(id)!;
  const picker = document.createElement("input");
  picker.type = "color";
  picker.setAttribute("aria-label", `选择${label}`);
  const hex = document.createElement("input");
  hex.type = "text";
  hex.pattern = "#[0-9a-fA-F]{6}";
  hex.maxLength = 7;
  hex.spellcheck = false;
  hex.autocomplete = "off";
  hex.required = emptyLabel === undefined;
  hex.placeholder = emptyLabel ?? "#RRGGBB";
  hex.setAttribute("aria-label", label);
  hex.title = emptyLabel ? `输入十六进制颜色，留空为${emptyLabel}` : "输入十六进制颜色";
  control.classList.add("color-control");
  control.append(picker, hex);
  let current = "";

  function preview(value: string) {
    picker.value = value || "#ffffff";
    control.toggleAttribute("data-empty", !value);
  }

  function set(value: string) {
    const normalized = hexColor(value);
    current = isDocumentColor(normalized) ? normalized.toLowerCase() : "";
    hex.value = current;
    preview(current);
  }

  function commit(value: string) {
    if ((!value && hex.required) || (value && !isDocumentColor(value))) return;
    const previous = current;
    set(value);
    if (current !== previous) onChange?.(current);
  }

  picker.addEventListener("change", () => commit(picker.value));
  hex.addEventListener("input", () => {
    if (!hex.value || isDocumentColor(hex.value)) preview(hex.value);
  });
  hex.addEventListener("change", () => commit(hex.value));
  if (onChange) hex.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (hex.reportValidity()) commit(hex.value);
  });
  return { set, get: () => hex.value.toLowerCase() };
}

export function alignmentControl(group: HTMLElement) {
  const choices = paragraphAlignments.map((value) => {
    const option = document.createElement("label");
    const name = alignmentLabels[value];
    option.title = name;
    const input = document.createElement("input");
    input.type = "radio";
    input.name = group.id;
    input.value = value;
    input.setAttribute("aria-label", name);
    const face = document.createElement("span");
    face.setAttribute("aria-hidden", "true");
    face.innerHTML = `<svg><use href="#align-${value}"/></svg>`;
    option.append(input, face);
    group.append(option);
    return { input, value };
  });
  return {
    get: () => choices.find(({ input }) => input.checked)?.value,
    set(value: ParagraphAlignment) {
      const choice = choices.find((choice) => choice.value === value);
      if (choice) choice.input.checked = true;
    },
  };
}

export function spacingInputs(prefix: string, property: "padding" | "margin") {
  const block = document.querySelector<HTMLInputElement>(`#${prefix}-${property}-block`)!;
  const inline = document.querySelector<HTMLInputElement>(`#${prefix}-${property}-inline`)!;
  block.max = inline.max = String(maxParagraphSpacing);
  return { block, inline };
}

export function showStylePopover(popover: HTMLElement, anchor: HTMLElement, align: "start" | "end") {
  if (!popover.matches(":popover-open")) popover.showPopover();
  const button = anchor.getBoundingClientRect();
  const { width, height } = popover.getBoundingClientRect();
  const left = align === "end" ? button.right - width : button.left;
  const below = button.bottom + 6;
  const above = button.top - height - 6;
  const top = below + height > innerHeight - 8 && above >= 8 ? above : below;
  popover.style.left = `${Math.max(8, Math.min(left, innerWidth - width - 8))}px`;
  popover.style.top = `${Math.max(8, Math.min(top, innerHeight - height - 8))}px`;
}

export function applyDocumentStyle(editor: HTMLElement, style: DocumentStyle) {
  editor.style.setProperty("--document-font-size", `${style.fontSize}px`);
  editor.style.setProperty("--document-color", style.color);
  if (style.background === "transparent") editor.style.removeProperty("--document-background");
  else editor.style.setProperty("--document-background", style.background);
  editor.style.setProperty("--document-line-height", String(style.lineHeight));
  editor.style.setProperty("--document-weight", style.bold ? "700" : "400");
  editor.style.setProperty("--document-align", style.align);
  editor.style.setProperty("--document-padding-block", `${style.paddingBlock}px`);
  editor.style.setProperty("--document-padding-inline", `${style.paddingInline}px`);
  editor.style.setProperty("--document-margin-block", `${style.marginBlock}px`);
  editor.style.setProperty("--document-margin-inline", `${style.marginInline}px`);
}
