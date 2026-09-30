// Image Builder starter templates — seeded as global (dealer_uuid NULL,
// is_template true) image_designs rows by scripts/seed-image-builder-templates.ts.
//
// Geometry is measured from the current Illustrator library images (scaled to
// each type's spec size), so a template reproduces the image it's named after:
//   Standard_Medium / Standard_Top / Standard_Medium_Blue / Narrow_medium,
//   BaseTemplate-backup-20260830-pricingblock, Shell_MedInfobox,
//   Base_Empty_Template.
// Fixed ids keep the seed idempotent.

import type { DesignDoc, ImageType } from "./spec";

export interface StarterTemplate {
  id: string;
  name: string;
  image_type: ImageType;
  design_json: DesignDoc;
}

const tid = (n: number) => `00000000-0000-4000-a163-${String(n).padStart(12, "0")}`;

// Addendum background frame (measured: stroke 12, radius 16, inset 37/78)
function addendumFrame(w: number, color = "#000000") {
  return { id: "frame", name: "Outer frame", type: "frame" as const,
    x: 37, y: 78, w: w - 37 - 39, h: 1495, stroke: color, strokeWidth: 12, radius: 16 };
}
/** Lower panel as its own rounded frame sharing the outer frame's sides and
 *  bottom — its top edge is the divider, with rounded inner corners (the notch). */
function lowerPanel(w: number, y: number, color = "#000000") {
  return { id: "lower", name: "Lower panel", type: "frame" as const,
    x: 37, y, w: w - 37 - 39, h: 1573 - y, stroke: color, strokeWidth: 12, radius: 16 };
}
/** Upper panel as its own rounded frame — its bottom edge is the divider. */
function upperPanel(w: number, yBottom: number, color = "#000000") {
  return { id: "upper", name: "Upper panel", type: "frame" as const,
    x: 37, y: 78, w: w - 37 - 39, h: yBottom - 78, stroke: color, strokeWidth: 12, radius: 16 };
}

const DISCLAIMER =
  "*INCLUDES DEALER INSTALLED OPTIONS\nPlus government fees and taxes, any finance charge, any dealer document processing charge, any electronic filing charge and any emissions testing charge.";

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    id: tid(1),
    name: "Classic Black Frame + Notch",
    image_type: "addendum_bg_standard",
    design_json: { version: 1, background: null, elements: [addendumFrame(638), lowerPanel(638, 1181)] },
  },
  {
    id: tid(2),
    name: "Classic Black Frame + Notch (Narrow)",
    image_type: "addendum_bg_narrow",
    design_json: { version: 1, background: null, elements: [addendumFrame(469), lowerPanel(469, 1181)] },
  },
  {
    id: tid(3),
    name: "Frame + Pricing Block",
    image_type: "infosheet_bg",
    design_json: {
      version: 1, background: null, elements: [
        { id: "frame", name: "Outer frame", type: "frame", x: 39, y: 76, w: 2578, h: 3285, stroke: "#000000", strokeWidth: 30, radius: 56 },
        { id: "bar", name: "Pricing bar", type: "box", x: 39, y: 2542, w: 2578, h: 266, fill: "#000000", opacity: 1, radius: 0, stroke: null, strokeWidth: 1 },
        { id: "price", name: "Price window", type: "box", x: 1613, y: 2566, w: 903, h: 218, fill: "#ffffff", opacity: 1, radius: 0, stroke: null, strokeWidth: 1 },
      ],
    },
  },
  {
    id: tid(4),
    name: "Two-Panel",
    image_type: "addendum_bg_standard",
    design_json: { version: 1, background: null, elements: [addendumFrame(638), upperPanel(638, 738)] },
  },
  {
    id: tid(5),
    name: "Colored Frame",
    image_type: "addendum_bg_standard",
    design_json: { version: 1, background: null, elements: [addendumFrame(638, "#2e3192")] },
  },
  {
    id: tid(6),
    name: "Dealer Infosheet",
    image_type: "infosheet_bg",
    design_json: {
      version: 1, background: null, elements: [
        { id: "frame", name: "Outer frame", type: "frame", x: 39, y: 76, w: 2578, h: 3285, stroke: "#000000", strokeWidth: 30, radius: 56 },
        { id: "header", name: "Header bar", type: "box", x: 39, y: 76, w: 2578, h: 300, fill: "#000000", opacity: 1, radius: 56, stroke: null, strokeWidth: 1 },
        { id: "name", name: "Dealer name", type: "text", x: 139, y: 156, w: 2378, h: 140, text: "YOUR DEALERSHIP NAME",
          font: "inter", size: 110, bold: true, color: "#ffffff", align: "center", lineHeight: 1.2 },
        { id: "bar", name: "Pricing bar", type: "box", x: 39, y: 2542, w: 2578, h: 266, fill: "#000000", opacity: 1, radius: 0, stroke: null, strokeWidth: 1 },
        { id: "price", name: "Price window", type: "box", x: 1613, y: 2566, w: 903, h: 218, fill: "#ffffff", opacity: 1, radius: 0, stroke: null, strokeWidth: 1 },
      ],
    },
  },
  {
    id: tid(7),
    name: "Disclaimer Box",
    image_type: "infobox",
    design_json: {
      version: 1, background: null, elements: [
        { id: "shell", name: "Black shell", type: "box", x: 19, y: 16, w: 515, h: 307, fill: "#000000", opacity: 1, radius: 20, stroke: null, strokeWidth: 1 },
        { id: "window", name: "Window", type: "box", knockout: true, x: 36, y: 31, w: 480, h: 197, fill: "#ffffff", opacity: 1, radius: 16, stroke: null, strokeWidth: 1 },
        { id: "disclaimer", name: "Disclaimer", type: "text", x: 42, y: 229, w: 470, h: 66, text: DISCLAIMER,
          font: "arial", size: 14.8, bold: true, color: "#ffffff", align: "left", lineHeight: 1.0 },
        { id: "notice", name: "Notice", type: "text", x: 36, y: 297, w: 480, h: 20, text: "THIS IS NOT AN AUTHORIZED FACTORY STICKER",
          font: "arial", size: 15.5, bold: true, color: "#ffffff", align: "center", lineHeight: 1.2 },
      ],
    },
  },
  {
    id: tid(8),
    name: "Not-a-Factory-Sticker",
    image_type: "infobox",
    design_json: {
      version: 1, background: null, elements: [
        { id: "shell", name: "Black shell", type: "box", x: 22, y: 22, w: 510, h: 296, fill: "#000000", opacity: 1, radius: 16, stroke: null, strokeWidth: 1 },
        { id: "window", name: "Window", type: "box", knockout: true, x: 38, y: 37, w: 476, h: 170, fill: "#ffffff", opacity: 1, radius: 14, stroke: null, strokeWidth: 1 },
        { id: "body", name: "Body text", type: "text", x: 70, y: 214, w: 413, h: 48,
          text: "This label has been affixed to the vehicle by the dealer. It has been designed to clearly indicate any additional charges. It is not affixed by the manufacturer.",
          font: "inter", size: 12, bold: false, color: "#ffffff", align: "center", lineHeight: 1.08 },
        { id: "headline", name: "Headline", type: "text", x: 60, y: 266, w: 432, h: 52,
          text: "THIS ADDENDUM STICKER IS NOT\nAN OFFICIAL FACTORY\nOR GOVERNMENT STICKER",
          font: "inter", size: 17, bold: true, color: "#ffffff", align: "center", lineHeight: 0.92 },
      ],
    },
  },
];
