import { describe, expect, it } from "vitest";
import { factKey, normalizeScope, parseFactKey, toFieldName } from "./text.ts";

describe("toFieldName", () => {
  it("splits camelCase before folding", () => {
    expect(toFieldName("phoneNumber")).toBe("phone_number");
    expect(toFieldName("appointmentDate")).toBe("appointment_date");
  });

  it("keeps existing snake_case and punctuation handling", () => {
    expect(toFieldName("Appointment Date!")).toBe("appointment_date");
    expect(toFieldName("price_try")).toBe("price_try");
    expect(toFieldName("???")).toBe("note");
  });
});

describe("fact keys", () => {
  it("keeps a scope as part of the key, normalized", () => {
    expect(toFieldName("Greeting@lang:PT")).toBe("greeting@lang:pt");
    expect(toFieldName("officeAddress@Org: Harbor University")).toBe("office_address@org:harbor-university");
    expect(toFieldName("greeting@")).toBe("greeting");
  });

  it("builds and splits `field@scope`", () => {
    expect(factKey("Greeting", "lang:pt")).toBe("greeting@lang:pt");
    expect(factKey("greeting")).toBe("greeting");
    expect(factKey("greeting@lang:pt")).toBe("greeting@lang:pt");
    expect(factKey("greeting@lang:pt", "lang:en")).toBe("greeting@lang:en");
    expect(parseFactKey("greeting@lang:pt")).toEqual({ field: "greeting", scope: "lang:pt" });
    expect(parseFactKey("greeting")).toEqual({ field: "greeting" });
    expect(normalizeScope(" Lang:PT ")).toBe("lang:pt");
  });
});
