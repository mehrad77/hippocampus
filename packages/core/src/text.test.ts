import { describe, expect, it } from "vitest";
import { toFieldName } from "./text.ts";

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
