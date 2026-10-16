import { describe, expect, it } from "bun:test";
import {
  equipmentMeta,
  equipmentName,
  equipmentTypeIcon,
  equipmentTypeLabel,
  formatPurchaseDate,
} from "./equipmentLabels";

describe("equipment labels", () => {
  it("names the starting types and falls back for types added later", () => {
    expect(equipmentTypeLabel("computer")).toBe("Computer");
    expect(equipmentTypeLabel("cell_phone")).toBe("Cell phone");
    expect(equipmentTypeLabel("monitor")).toBe("Monitor");
    expect(equipmentTypeLabel("docking_station")).toBe("Docking station");
    expect(equipmentTypeIcon("cell_phone")).toBe("cellPhone");
    expect(equipmentTypeIcon("docking_station")).toBe("equipment");
  });

  it("describes an item by what is recorded about it", () => {
    const purchased = formatPurchaseDate("2026-03-01");
    expect(purchased).toContain("2026");
    expect(
      equipmentMeta({
        purchaseDate: "2026-03-01",
        serialNumber: "C02XYZ",
        type: "computer",
      }),
    ).toBe(`Computer · C02XYZ · Purchased ${purchased}`);
    expect(
      equipmentMeta({
        purchaseDate: null,
        serialNumber: null,
        type: "monitor",
      }),
    ).toBe("Monitor");
  });

  it("names an item by make and model", () => {
    expect(equipmentName({ make: "Apple", model: "MacBook Pro" })).toBe(
      "Apple MacBook Pro",
    );
  });
});
