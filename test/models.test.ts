import { expect, test } from "bun:test";
import { parseRoles, roleFor } from "../src/models.ts";

test("each task uses its own omp role when defined, else the next one in its chain", () => {
  const none = {};
  expect(roleFor("assistant", none)).toBeNull(); // omp's default model
  expect(roleFor("proofread", none)).toBe("smol");
  expect(roleFor("rewrite", none)).toBe("smol");

  const proofreadOnly = { proofread: "openai/gpt-5-mini", smol: "x/y" };
  expect(roleFor("proofread", proofreadOnly)).toBe("proofread");
  expect(roleFor("rewrite", proofreadOnly)).toBe("proofread"); // rewrite follows proofread

  const all = { latex: "a/b", proofread: "c/d", rewrite: "e/f" };
  expect(roleFor("assistant", all)).toBe("latex");
  expect(roleFor("rewrite", all)).toBe("rewrite");
});

test("a role named like an Object method is not mistaken for a defined one", () => {
  expect(roleFor("assistant", JSON.parse('{"constructor": "x"}'))).toBeNull();
});

test("omp's modelRoles JSON yields its string roles; anything else yields none", () => {
  expect(parseRoles(JSON.stringify({ key: "modelRoles", value: { smol: "a/b:medium", odd: 3, tiny: "c/d" } }))).toEqual({ smol: "a/b:medium", tiny: "c/d" });
  expect(parseRoles("not json")).toEqual({});
  expect(parseRoles(JSON.stringify({ key: "modelRoles" }))).toEqual({});
});
