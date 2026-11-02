import { describe, expect, it } from "vitest";
import { inboundAddress, inboundLocation } from "./inbound-structured";

describe("inbound structured payloads", () => {
  it("keeps a location's coordinates and rejects impossible ones", () => {
    expect(inboundLocation({ latitude: 12.9, longitude: 77.5, name: " Office ", address: "" }))
      .toEqual({ location: { latitude: 12.9, longitude: 77.5, name: "Office", address: undefined } });
    expect(inboundLocation({ latitude: 91, longitude: 0 })).toBeNull();
    expect(inboundLocation({ latitude: "x", longitude: 0 })).toBeNull();
  });

  it("reads only the known address-form fields", () => {
    const reply = { name: "address_message", response_json: JSON.stringify({ values: { city: "Pune", in_pin_code: "411001", evil: "x", state: "" } }) };
    expect(inboundAddress(reply)).toEqual({ address: { city: "Pune", in_pin_code: "411001" } });
  });

  it("ignores other forms, malformed JSON and oversized replies", () => {
    expect(inboundAddress({ name: "flow", response_json: "{}" })).toBeNull();
    expect(inboundAddress({ name: "address_message", response_json: "{not json" })).toBeNull();
    expect(inboundAddress({ name: "address_message", response_json: JSON.stringify({ values: { city: "x".repeat(9000) } }) })).toBeNull();
    expect(inboundAddress(undefined)).toBeNull();
  });
});
