import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProductMark } from "./index";

describe("ProductMark", () => {
  it("names the product", () => {
    render(<ProductMark />);
    expect(screen.getByText("LunarHunt")).toBeTruthy();
  });
});
