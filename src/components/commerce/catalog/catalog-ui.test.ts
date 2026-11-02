import { describe, expect, it } from "vitest";
import { productQueryString, sendRejectedDefinitely } from "./catalog-api";
import { draftBody } from "./send-product-dialog";
import { availabilityKey } from "./products-view";
import { productPrice } from "./product-picker";

const blank = { header: "", body: "", footer: "", single: null, thumbnail: null, sections: [] };

describe("draftBody", () => {
  it("builds each kind only when its required parts are there", () => {
    expect(draftBody("product", blank)).toBeNull();
    expect(draftBody("product", { ...blank, single: "p1", footer: " thanks " })).toEqual({ kind: "product", product_id: "p1", body: undefined, footer: "thanks" });
    expect(draftBody("catalog", blank)).toBeNull();
    expect(draftBody("catalog", { ...blank, body: "Browse", thumbnail: "p2" })).toEqual({ kind: "catalog", body: "Browse", footer: undefined, thumbnail_product_id: "p2" });
  });

  it("drops empty sections and needs titles when several remain", () => {
    const sections = [{ title: "", products: [{ id: "a", name: "A" }] }, { title: "", products: [] }];
    expect(draftBody("product_list", { ...blank, header: "H", body: "B", sections })).toEqual({
      kind: "product_list", header: "H", body: "B", footer: undefined, sections: [{ title: "", product_ids: ["a"] }],
    });
    const two = [{ title: "", products: [{ id: "a", name: "A" }] }, { title: "B", products: [{ id: "b", name: "B" }] }];
    expect(draftBody("product_list", { ...blank, header: "H", body: "B", sections: two })).toBeNull();
    expect(draftBody("product_list", { ...blank, body: "B", sections })).toBeNull();
  });
});

it("keeps the request id after an unknown outcome and renews it after a refusal", () => {
  expect(sendRejectedDefinitely(409, "window_closed")).toBe(true);
  expect(sendRejectedDefinitely(502, undefined)).toBe(true);
  expect(sendRejectedDefinitely(409, undefined)).toBe(false);
  expect(sendRejectedDefinitely(500, undefined)).toBe(false);
});

it("builds the products query string without empty values", () => {
  expect(productQueryString({})).toBe("");
  expect(productQueryString({ q: " shoe ", availability: "in_stock", conversationId: "c", hidden: true, offset: 50 }))
    .toBe("?q=shoe&availability=in_stock&conversation_id=c&hidden=1&offset=50");
});

it("labels availability and formats prices from minor units", () => {
  expect(availabilityKey("In Stock")).toBe("in_stock");
  expect(availabilityKey("out of stock")).toBe("out_of_stock");
  expect(availabilityKey("preorder")).toBe("other");
  expect(availabilityKey(null)).toBe("other");
  expect(productPrice({ price_minor: 49900, currency: "INR" }, "en")).toBe("₹499.00");
  expect(productPrice({ price_minor: null, currency: "INR" }, "en")).toBeNull();
});
