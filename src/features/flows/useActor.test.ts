import { describe, expect, it } from "vitest";
import { actorForPrincipal } from "./useActor";

describe("actorForPrincipal", () => {
  const actorA = { owner: "principal-a" };

  it("returns an actor only to the principal it was constructed for", () => {
    expect(actorForPrincipal({ principal: "principal-a", actor: actorA }, "principal-a")).toBe(actorA);
  });

  it("hides a stale actor immediately when authentication changes", () => {
    expect(actorForPrincipal({ principal: "principal-a", actor: actorA }, "principal-b")).toBeNull();
    expect(actorForPrincipal({ principal: "principal-a", actor: actorA }, null)).toBeNull();
  });
});
