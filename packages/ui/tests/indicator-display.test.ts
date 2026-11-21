import { describe, expect, it } from "vitest";
import { formatDisplayUnit, formatRawIndicatorResult, formatReferenceRange } from "../src/utils/indicator-display";

describe("count unit display", () => {
  it("renders OCR scientific count units with a superscript", () => {
    expect(formatDisplayUnit("109/L")).toBe("10⁹/L");
    expect(formatDisplayUnit("10~9/L")).toBe("10⁹/L");
    expect(formatDisplayUnit('10"9/L')).toBe("10⁹/L");
    expect(formatDisplayUnit("10-9/L")).toBe("10⁹/L");
    expect(formatDisplayUnit("10^9/L")).toBe("10⁹/L");
    expect(formatDisplayUnit("10^12/L")).toBe("10¹²/L");
    expect(formatDisplayUnit("×109/L")).toBe("10⁹/L");
    expect(formatDisplayUnit("10^3/uL")).toBe("10³/μL");
  });

  it("leaves ordinary units unchanged", () => {
    for (const unit of ["mmol/L", "g/L", "%", "fL", "mg/L", "U/L"]) {
      expect(formatDisplayUnit(unit)).toBe(unit);
    }
  });

  it("formats the value line without repeating a unit already present", () => {
    expect(formatRawIndicatorResult("270", "109/L")).toBe("270 10⁹/L");
    expect(formatRawIndicatorResult("4.62 10^12/L", "10^12/L")).toBe("4.62 10¹²/L");
    expect(formatRawIndicatorResult("89 mmHg", "mmHg")).toBe("89 mmHg");
  });

  it("uses the same unit form on a numeric reference range", () => {
    expect(formatReferenceRange({
      referenceLow: 3.5,
      referenceHigh: 9.5,
      referenceText: null,
      unit: "10^9/L"
    })).toBe("参考 3.5 - 9.5 10⁹/L");
  });
});
