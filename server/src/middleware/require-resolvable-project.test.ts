import { describe, expect, it } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../errors.js";
import {
  createRequireResolvableProject,
  type RequireResolvableProjectDeps,
} from "./require-resolvable-project.js";

// --- Stub services (mirror the 19-assertion reference harness) --------------
// issuesSvc.getById resolves parents from this map; anything else -> null.
const ISSUES: Record<string, { id: string; projectId: string | null }> = {
  "p-resolved": { id: "p-resolved", projectId: "proj-1" },
  "p-null": { id: "p-null", projectId: null },
};
const issuesSvc = {
  async getById(id: string) {
    return Object.prototype.hasOwnProperty.call(ISSUES, id) ? ISSUES[id] : null;
  },
};

// projectsSvc.getById returns {} for known project ids, else null.
const KNOWN_PROJECTS = new Set(["proj-1", "proj-2"]);
const projectsSvc = {
  async getById(id: string) {
    return KNOWN_PROJECTS.has(id) ? {} : null;
  },
};

const requireProject = createRequireResolvableProject({ issuesSvc, projectsSvc });

type Mode = "create" | "child" | "patch" | "decompose";

interface RunResult {
  nextCalled: boolean;
  nextErr: unknown;
  thrown: unknown;
}

// Run one guard invocation to completion, capturing the outcome. On violation
// the guard throws an HttpError (house style — express 5 forwards the rejection
// to the error handler), so failures surface as `thrown`, not as a response.
async function run(
  mode: Mode,
  reqInit: { params?: Record<string, string>; body?: unknown },
): Promise<RunResult> {
  const req = { params: reqInit.params ?? {}, body: reqInit.body ?? {} } as unknown as Request;
  const res = {} as Response;
  let nextCalled = false;
  let nextErr: unknown;
  const next: NextFunction = (err) => {
    nextCalled = true;
    if (err) nextErr = err;
  };
  let thrown: unknown;
  try {
    await requireProject(mode)(req, res, next);
  } catch (err) {
    thrown = err;
  }
  return { nextCalled, nextErr, thrown };
}

// Assert the guard passed the request through: next() with no error, nothing thrown.
function expectNext(r: RunResult) {
  expect(r.nextCalled).toBe(true);
  expect(r.nextErr).toBeUndefined();
  expect(r.thrown).toBeUndefined();
}

// Assert the guard rejected with a 422 HttpError carrying the given details.error.
function expect422(r: RunResult, error: string): Record<string, unknown> {
  expect(r.nextCalled).toBe(false);
  expect(r.thrown).toBeInstanceOf(HttpError);
  const err = r.thrown as HttpError;
  expect(err.status).toBe(422);
  const details = err.details as Record<string, unknown>;
  expect(details.error).toBe(error);
  return details;
}

describe("createRequireResolvableProject", () => {
  it("1  create body {} -> 422 project_required", async () => {
    const r = await run("create", { body: {} });
    expect422(r, "project_required");
  });

  it("2  create projectId null -> 422 project_required", async () => {
    const r = await run("create", { body: { projectId: null } });
    expect422(r, "project_required");
  });

  it("3  create projectId 'nope' -> 422 project_unresolvable", async () => {
    const r = await run("create", { body: { projectId: "nope" } });
    const details = expect422(r, "project_unresolvable");
    expect(details.projectId).toBe("nope");
  });

  it("4  create projectId 'proj-1' -> next()", async () => {
    const r = await run("create", { body: { projectId: "proj-1" } });
    expectNext(r);
  });

  it("5  patch without projectId key -> next() (identity untouched)", async () => {
    const r = await run("patch", { params: { id: "p-resolved" }, body: { title: "x" } });
    expectNext(r);
  });

  it("6  patch projectId null -> 422 project_required", async () => {
    const r = await run("patch", { params: { id: "p-resolved" }, body: { projectId: null } });
    expect422(r, "project_required");
  });

  it("7  patch projectId 'proj-2' -> next()", async () => {
    const r = await run("patch", { params: { id: "p-resolved" }, body: { projectId: "proj-2" } });
    expectNext(r);
  });

  it("8  child body {} params.id 'p-resolved' -> next() (inherits)", async () => {
    const r = await run("child", { params: { id: "p-resolved" }, body: {} });
    expectNext(r);
  });

  it("9  child body {} params.id 'p-null' -> 422 project_required", async () => {
    const r = await run("child", { params: { id: "p-null" }, body: {} });
    expect422(r, "project_required");
  });

  it("10 child body {} params.id 'missing' -> next() (parent-missing passthrough)", async () => {
    const r = await run("child", { params: { id: "missing" }, body: {} });
    expectNext(r);
  });

  it("11 child projectId 'nope' -> 422 project_unresolvable", async () => {
    const r = await run("child", { params: { id: "p-resolved" }, body: { projectId: "nope" } });
    expect422(r, "project_unresolvable");
  });

  it("12 decompose params.id 'missing' -> next()", async () => {
    const r = await run("decompose", { params: { id: "missing" }, body: { children: [{}] } });
    expectNext(r);
  });

  it("13 decompose parent 'p-resolved' children [{},{}] -> next() (both inherit)", async () => {
    const r = await run("decompose", { params: { id: "p-resolved" }, body: { children: [{}, {}] } });
    expectNext(r);
  });

  it("14 decompose parent 'p-null' children [{},{projectId:'proj-1'}] -> 422 project_required, childIndexes [0]", async () => {
    const r = await run("decompose", {
      params: { id: "p-null" },
      body: { children: [{}, { projectId: "proj-1" }] },
    });
    const details = expect422(r, "project_required");
    expect(details.childIndexes).toEqual([0]);
  });

  it("15 decompose parent 'p-resolved' children [{projectId:'nope'},{}] -> 422 project_unresolvable, projectId 'nope', childIndexes [0]", async () => {
    const r = await run("decompose", {
      params: { id: "p-resolved" },
      body: { children: [{ projectId: "nope" }, {}] },
    });
    const details = expect422(r, "project_unresolvable");
    expect(details.projectId).toBe("nope");
    expect(details.childIndexes).toEqual([0]);
  });

  it("16 decompose children [] -> next()", async () => {
    const r = await run("decompose", { params: { id: "p-resolved" }, body: { children: [] } });
    expectNext(r);
  });

  it("17 factory called without deps -> throws (mentions missing deps)", () => {
    expect(() =>
      createRequireResolvableProject({} as unknown as RequireResolvableProjectDeps),
    ).toThrow(/missing deps/i);
  });

  it("18 decompose parent 'p-resolved' children [null,{}] -> next() (null inherits resolved parent)", async () => {
    const r = await run("decompose", { params: { id: "p-resolved" }, body: { children: [null, {}] } });
    expectNext(r);
  });

  it("19 decompose parent 'p-null' children [null] -> 422 project_required, childIndexes [0]", async () => {
    const r = await run("decompose", { params: { id: "p-null" }, body: { children: [null] } });
    const details = expect422(r, "project_required");
    expect(details.childIndexes).toEqual([0]);
  });
});
