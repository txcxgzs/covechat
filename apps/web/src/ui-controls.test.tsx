import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./ui-controls";

describe("button primitive", () => {
  it("exposes loading and disabled state without losing its label", () => {
    const markup = renderToStaticMarkup(<Button loading variant="danger">Delete</Button>);
    expect(markup).toContain("ui-button-danger");
    expect(markup).toContain("aria-busy=\"true\"");
    expect(markup).toContain("disabled=\"\"");
    expect(markup).toContain("Delete");
  });
});
