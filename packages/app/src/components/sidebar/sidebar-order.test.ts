import { expect, it } from "vitest";
import { onlineHostsSupport } from "./sidebar-order";

it("lets an offline host that cannot report its features keep sorting on", () => {
  const support = new Map([
    ["mac", true],
    ["dead", false],
  ]);
  expect(
    onlineHostsSupport(
      support,
      new Map([
        ["mac", "online"],
        ["dead", "connecting"],
      ]),
    ),
  ).toBe(true);
  expect(
    onlineHostsSupport(
      support,
      new Map([
        ["mac", "online"],
        ["dead", "online"],
      ]),
    ),
  ).toBe(false);
});
