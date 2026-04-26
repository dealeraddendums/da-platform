export interface LabelOption {
  qty: number;
  price: number;
  shipping: 'standard' | 'fedex';
}

export interface LabelProduct {
  sku: string;
  name: string;
  size: string;
  options: LabelOption[];
}

export const LABEL_PRODUCTS: LabelProduct[] = [
  {
    sku: '8300-1',
    name: 'Regular Addendums',
    size: '4.25"×11"',
    options: [
      { qty: 250, price: 75, shipping: 'standard' },
      { qty: 250, price: 125, shipping: 'fedex' },
      { qty: 500, price: 135, shipping: 'standard' },
      { qty: 1000, price: 255, shipping: 'standard' },
      { qty: 2000, price: 455, shipping: 'standard' },
    ],
  },
  {
    sku: '9300-1',
    name: 'Regular Addendums — Waterproof',
    size: '4.25"×11"',
    options: [
      { qty: 250, price: 115, shipping: 'standard' },
      { qty: 250, price: 165, shipping: 'fedex' },
      { qty: 500, price: 220, shipping: 'standard' },
      { qty: 1000, price: 430, shipping: 'standard' },
      { qty: 2000, price: 810, shipping: 'standard' },
    ],
  },
  {
    sku: '8300-3',
    name: 'Narrow Addendums',
    size: '3.125"×11"',
    options: [
      { qty: 250, price: 75, shipping: 'standard' },
      { qty: 250, price: 125, shipping: 'fedex' },
      { qty: 500, price: 135, shipping: 'standard' },
      { qty: 1000, price: 255, shipping: 'standard' },
      { qty: 2000, price: 455, shipping: 'standard' },
    ],
  },
  {
    sku: '9300-3',
    name: 'Narrow Addendums — Waterproof',
    size: '3.125"×11"',
    options: [
      { qty: 250, price: 75, shipping: 'standard' },
      { qty: 250, price: 165, shipping: 'fedex' },
      { qty: 500, price: 220, shipping: 'standard' },
      { qty: 1000, price: 430, shipping: 'standard' },
      { qty: 2000, price: 810, shipping: 'standard' },
    ],
  },
  {
    sku: '8300',
    name: 'Full Sheet Labels',
    size: '8.5"×11"',
    options: [
      { qty: 250, price: 105, shipping: 'standard' },
      { qty: 500, price: 190, shipping: 'standard' },
      { qty: 1000, price: 370, shipping: 'standard' },
      { qty: 2000, price: 725, shipping: 'standard' },
    ],
  },
  {
    sku: '9300',
    name: 'Full Sheet Labels — Waterproof',
    size: '8.5"×11"',
    options: [
      { qty: 100, price: 135, shipping: 'standard' },
      { qty: 200, price: 250, shipping: 'standard' },
      { qty: 400, price: 490, shipping: 'standard' },
      { qty: 800, price: 810, shipping: 'standard' },
    ],
  },
];
