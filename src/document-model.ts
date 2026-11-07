import { Extension, type JSONContent } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Color, FontSize, TextStyle } from "@tiptap/extension-text-style";
import StarterKit from "@tiptap/starter-kit";

export const headingLevels = [1, 2, 3, 4, 5, 6] as const;
export const paragraphNodeTypes = ["paragraph", "heading"];
export const paragraphBorderStyles = ["none", "solid", "dashed", "dotted"] as const;
export const defaultQuoteColor = "#8aaf99";
export const defaultBorderColor = "#a4b1a8";
export const maxParagraphBorderWidth = 8;
export const minFontSize = 12;
export const maxFontSize = 32;
export const maxParagraphLevel = 5;
export const paragraphAlignments = ["left", "center", "right", "justify"] as const;
export type ParagraphAlignment = (typeof paragraphAlignments)[number];
export const maxParagraphSpacing = 64;
export const documentLineHeights = [1.4, 1.6, 1.8, 2, 2.2] as const;

export interface DocumentStyle {
  fontSize: number;
  color: string;
  background: string;
  lineHeight: number;
  bold: boolean;
  align: ParagraphAlignment;
  paddingBlock: number;
  paddingInline: number;
  marginBlock: number;
  marginInline: number;
}

export const defaultDocumentStyle: DocumentStyle = {
  fontSize: 16, color: "#25352b", background: "transparent", lineHeight: 1.8, bold: false,
  align: "left", paddingBlock: 0, paddingInline: 0,
  marginBlock: 7, marginInline: 0,
};

export function isParagraphAlignment(value: unknown): value is ParagraphAlignment {
  return paragraphAlignments.some((alignment) => alignment === value);
}

export function isParagraphSpacing(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maxParagraphSpacing;
}

export function isDocumentFontSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minFontSize && value <= maxFontSize;
}

export function isDocumentLineHeight(value: unknown): value is number {
  return documentLineHeights.some((height) => height === value);
}

export function isDocumentColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function isDocumentBackground(value: unknown): value is string {
  return value === "transparent" || isDocumentColor(value);
}

function pixelValue(css: string) {
  return css.endsWith("px") ? Number(css.slice(0, -2)) : null;
}

export function hexColor(css: string) {
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(css);
  return rgb ? `#${rgb.slice(1).map((channel) => Number(channel).toString(16).padStart(2, "0")).join("")}` : css;
}

function styleAttribute<T>(
  attribute: string,
  property: string,
  isValid: (value: unknown) => value is T,
  parse: (css: string) => unknown,
  format: (value: T) => string,
) {
  return {
    default: null,
    keepOnSplit: false,
    validate(value: unknown) {
      if (value !== null && !isValid(value)) throw new Error(`Invalid ${attribute}`);
    },
    parseHTML(element: HTMLElement) {
      const value = parse(element.style.getPropertyValue(property).trim());
      return isValid(value) ? value : null;
    },
    renderHTML(attributes: Record<string, unknown>) {
      const value = attributes[attribute];
      return isValid(value) ? { style: `${property}: ${format(value)}` } : {};
    },
  };
}

const paragraphProperties = Extension.create({
  name: "paragraphProperties",
  addGlobalAttributes() {
    return [{
      types: paragraphNodeTypes,
      attributes: {
        paragraphLevel: {
          default: 0,
          validate(value: unknown) {
            if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > maxParagraphLevel) {
              throw new Error("Invalid paragraph level");
            }
          },
          parseHTML(element) {
            const level = Number(element.dataset.paragraphLevel);
            return Number.isInteger(level) && level >= 0 && level <= maxParagraphLevel ? level : 0;
          },
          renderHTML: ({ paragraphLevel }) => paragraphLevel ? { "data-paragraph-level": paragraphLevel } : {},
        },
        paragraphAlign: styleAttribute("paragraphAlign", "text-align", isParagraphAlignment, String, String),
        paragraphPaddingBlock: styleAttribute("paragraphPaddingBlock", "padding-block", isParagraphSpacing, pixelValue, (value) => `${value}px`),
        paragraphPaddingInline: styleAttribute("paragraphPaddingInline", "padding-inline", isParagraphSpacing, pixelValue, (value) => `${value}px`),
        paragraphMarginBlock: styleAttribute("paragraphMarginBlock", "margin-block", isParagraphSpacing, pixelValue, (value) => `${value}px`),
        paragraphMarginInline: styleAttribute("paragraphMarginInline", "margin-inline", isParagraphSpacing, pixelValue, (value) => `${value}px`),
        paragraphFontSize: styleAttribute("paragraphFontSize", "font-size", isDocumentFontSize, pixelValue, (value) => `${value}px`),
        paragraphColor: styleAttribute("paragraphColor", "color", isDocumentColor, hexColor, String),
        paragraphBackground: styleAttribute("paragraphBackground", "background-color", isDocumentBackground, hexColor, String),
        paragraphQuote: {
          default: false,
          keepOnSplit: false,
          validate(value: unknown) {
            if (typeof value !== "boolean") throw new Error("Invalid paragraph quote");
          },
          parseHTML: (element) => element.hasAttribute("data-paragraph-quote"),
          renderHTML: ({ paragraphQuote }) => paragraphQuote ? { "data-paragraph-quote": "true" } : {},
        },
        paragraphQuoteColor: styleAttribute("paragraphQuoteColor", "--paragraph-quote-color", isDocumentColor, hexColor, String),
        paragraphBorderStyle: styleAttribute("paragraphBorderStyle", "border-style",
          (value): value is string => paragraphBorderStyles.some((style) => style === value), String, String),
        paragraphBorderWidth: styleAttribute("paragraphBorderWidth", "border-width",
          (value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= maxParagraphBorderWidth,
          pixelValue, (value) => `${value}px`),
        paragraphBorderColor: styleAttribute("paragraphBorderColor", "border-color", isDocumentColor, hexColor, String),
        paragraphLineHeight: styleAttribute("paragraphLineHeight", "line-height", isDocumentLineHeight, Number, String),
        paragraphBold: styleAttribute("paragraphBold", "font-weight", (value): value is boolean => typeof value === "boolean",
          (css) => css === "bold" || css === "700" ? true : css === "normal" || css === "400" ? false : null,
          (value) => value ? "700" : "400"),
      },
    }];
  },
});

export const documentExtensions = [
  StarterKit.configure({
    heading: { levels: [...headingLevels] },
    link: { openOnClick: false },
  }),
  Image.configure({ inline: true }),
  TaskList,
  TaskItem.configure({ nested: true }),
  TableKit,
  TextStyle,
  Color,
  FontSize,
  paragraphProperties,
];

export const untitled = "未命名文档";
export const maxTitleLength = 160;
export const emptyBody: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };
export const numberingStyles = ["decimal", "chinese", "bullet"] as const;
export type NumberingStyle = typeof numberingStyles[number];

export interface SectionGroup {
  numbering: NumberingStyle;
  sections: NarrativeSection[];
}

export interface NarrativeSection extends SectionGroup {
  id: string;
  title: string;
  body: JSONContent;
  // Preserve source saved by older versions alongside the editable body.
  markdown?: string;
}

export function newSection(id: string, title: string): NarrativeSection {
  return { id, title, body: emptyBody, numbering: "decimal", sections: [] };
}

export interface DocumentSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface NarrativeDocument extends DocumentSummary {
  content: SectionGroup & { style?: DocumentStyle };
  revision: number;
}
