// The demo shop's catalog: shared by the shop routes (server-side pricing, immune to
// client tampering) and the MCP fiat_pay tool (its default merchant name).

export const SHOP_MERCHANT = "s0nder supply co.";

// demo pricing: everything cheap and honest — test-mode Stripe purchases settle as
// real Stripe test charges. The decline beat comes from the card's spend budget, not
// the catalog: issue the card with budget.spend below the dearest item and the
// checkout surfaces the card's own typed refusal (over_spend_limit).
export const SHOP_PRODUCTS = [
  { id: "espresso", name: "Double Espresso", priceCents: 5 },
  { id: "stickers", name: "Sticker Pack", priceCents: 25 },
  { id: "notebook", name: "Field Notebook", priceCents: 90 },
  { id: "keycaps", name: "Artisan Keycap Set", priceCents: 150 },
  { id: "cable", name: "Braided Desk Cable", priceCents: 275 },
  { id: "stand", name: "Headphone Stand, Walnut", priceCents: 490 },
];
