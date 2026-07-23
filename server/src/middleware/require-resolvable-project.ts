import type { Request, NextFunction, RequestHandler } from "express";
import { unprocessable } from "../errors.js";

/**
 * require-resolvable-project — the hard project-identity gate for the Paperclip
 * fork. Forward-only by construction: it fires only on the four mutation routes
 * below (new work + explicit project changes) and never scans or rewrites the
 * historical nulls. A child of an already-resolved parent passes (it inherits
 * parent.projectId); a PATCH that does not touch projectId passes untouched.
 * Only a genuinely-orphan new issue (or a PATCH/child/decompose that sets an
 * absent or unknown project) is rejected.
 *
 * Mounted as the LAST middleware before the async handler, AFTER validate(...),
 * in routes/issues.ts — line numbers verified read-only 2026-07-23 against the
 * deployed fork:
 *   6259  POST  /companies/:companyId/issues              -> mode "create"
 *   6485  POST  /issues/:id/children                       -> mode "child"
 *   6926  PATCH /issues/:id                                -> mode "patch"
 *   6666  POST  /issues/:id/accepted-plan-decompositions   -> mode "decompose"
 *
 * Scope note: this is an HTTP-layer gate — all agent/API writes pass through it;
 * engine-internal writes that do not traverse these routes are covered by the
 * contract + steward layers (identity law 01 §3.2–3.3), not by this middleware.
 * Precision: this guard verifies the project exists IN PAPERCLIP; the
 * project-to-registry (Project_Code) link is audited by the daily identity
 * steward — a deliberate defense-in-depth split, not a gap.
 *
 * Semantics are pinned by the colocated vitest suite
 * (require-resolvable-project.test.ts), ported 1:1 from a 19-assertion harness.
 */

// Sentinels for control flow, kept out of the projectId value space.
const SKIP = Symbol("skip"); // this mutation does not touch project identity
const PARENT_MISSING = Symbol("parentMissing"); // let the route's own 404 handle it

type Mode = "create" | "child" | "patch" | "decompose";

export interface RequireResolvableProjectDeps {
  // issueService(db) — parent lookup for children + decompositions.
  issuesSvc: { getById(id: string): Promise<{ projectId?: string | null } | null | undefined> };
  // projectService(db) — the app's own project resolver (null/undefined = unresolvable).
  projectsSvc: { getById(id: string): Promise<unknown> };
}

const PROJECT_REQUIRED_MESSAGE =
  "This issue has no project. Every issue must belong to an existing Paperclip "
  + "project — and every client project carries a Project_Code in the NocoDB "
  + "registry (the daily identity steward audits that link). Resolve the "
  + "Project_Code from the registry and set projectId before creating or "
  + "reparenting. Do not create orphan work (identity law 01 §3).";

const DECOMPOSE_PROJECT_REQUIRED_MESSAGE =
  "Decomposition children at those indexes resolve to no project (no child "
  + "projectId and the source issue has none). Every issue must belong to an "
  + "existing Paperclip project — and every client project carries a "
  + "Project_Code in the NocoDB registry (the daily identity steward audits "
  + "that link). Do not create orphan work (identity law 01 §3).";

function projectUnresolvableMessage(projectId: string): string {
  return (
    `projectId "${projectId}" does not resolve to an existing Paperclip `
    + "project. Use a project registered in the NocoDB identity registry "
    + "(Project_Code) — or run the new-engagement onboarding (ops-stack "
    + "docs/pm-agent/09-onboarding.md) if this is genuinely new work. Never "
    + "invent a project (identity law 01 §3)."
  );
}

export function createRequireResolvableProject(
  deps: RequireResolvableProjectDeps,
): (mode: Mode) => RequestHandler {
  const { issuesSvc, projectsSvc } = deps;
  if (!issuesSvc || !projectsSvc) {
    throw new Error(
      "require-resolvable-project: missing deps. Pass { issuesSvc: issueService(db), "
      + "projectsSvc: projectService(db) } — the same instances issues.ts builds.",
    );
  }

  // Compute the projectId this mutation would EFFECTIVELY result in.
  async function effectiveProjectId(
    mode: Mode,
    req: Request,
  ): Promise<string | null | typeof SKIP | typeof PARENT_MISSING> {
    const body = (req.body ?? {}) as { projectId?: string | null };
    if (mode === "create") {
      // A top-level issue: the project is whatever the body carries (may be absent).
      return body.projectId ?? null;
    }
    if (mode === "patch") {
      // Only enforce when the patch explicitly touches projectId. If the key is
      // absent, identity is not being changed -> pass through untouched.
      if (!Object.prototype.hasOwnProperty.call(body, "projectId")) return SKIP;
      return body.projectId ?? null;
    }
    if (mode === "child") {
      // Replicates the handler: createBody.projectId ?? parent.projectId ?? null.
      if (body.projectId != null) return body.projectId;
      const parentId = req.params.id;
      const parent = parentId ? await issuesSvc.getById(parentId) : null;
      if (!parent) return PARENT_MISSING; // route already 404s on a missing parent
      return parent.projectId ?? null;
    }
    throw new Error(`require-resolvable-project: unknown mode "${mode as string}"`);
  }

  /**
   * Multi-child variant for POST /issues/:id/accepted-plan-decompositions. The
   * handler creates one child per req.body.children element with projectId:
   * childBody.projectId ?? sourceIssue.projectId ?? null — so every child's
   * effective project must resolve, or the decomposition is orphan work.
   */
  async function handleDecompose(req: Request, next: NextFunction): Promise<void> {
    const parent = await issuesSvc.getById(req.params.id);
    // Missing parent: let the route's own 404 handle it (mirrors PARENT_MISSING).
    if (!parent) return next();

    // Mounts AFTER validate(createAcceptedPlanDecompositionSchema). Shapes zod
    // rejects anyway are still handled defensively: non-array children -> treated
    // as empty (the validator owns the 400); null elements -> inherit the parent.
    const body = (req.body ?? {}) as { children?: unknown };
    const children = Array.isArray(body.children) ? body.children : [];
    // Nothing to gate — the route's validator owns min-length.
    if (children.length === 0) return next();

    // Effective project per child, mirroring the handler's inheritance. A null or
    // non-object element carries no explicit projectId, so it inherits the parent.
    const effective: (string | null)[] = children.map((child) => {
      const c: { projectId?: string | null } =
        child != null && typeof child === "object" ? (child as { projectId?: string | null }) : {};
      return c.projectId ?? parent.projectId ?? null;
    });

    // (1) Any child with absent identity — orphan work. Report every index.
    const missingIndexes: number[] = [];
    effective.forEach((id, i) => {
      if (id == null || id === "") missingIndexes.push(i);
    });
    if (missingIndexes.length > 0) {
      throw unprocessable(DECOMPOSE_PROJECT_REQUIRED_MESSAGE, {
        error: "project_required",
        field: "projectId",
        childIndexes: missingIndexes,
      });
    }

    // (2) Present but unknown — validate the DISTINCT non-null ids in
    // first-appearance order, one lookup per distinct id. The first id that does
    // not resolve blocks the whole decomposition.
    const distinct: string[] = [];
    for (const id of effective) {
      if (id !== null && !distinct.includes(id)) distinct.push(id);
    }
    for (const id of distinct) {
      const project = await projectsSvc.getById(id);
      if (!project) {
        const childIndexes: number[] = [];
        effective.forEach((eid, i) => {
          if (eid === id) childIndexes.push(i);
        });
        throw unprocessable(projectUnresolvableMessage(id), {
          error: "project_unresolvable",
          field: "projectId",
          projectId: id,
          childIndexes,
        });
      }
    }

    // All children resolve — proceed to the real handler.
    return next();
  }

  return function requireResolvableProject(mode: Mode): RequestHandler {
    return async (req, _res, next) => {
      if (mode === "decompose") {
        return handleDecompose(req, next);
      }

      const projectId = await effectiveProjectId(mode, req);
      if (projectId === SKIP || projectId === PARENT_MISSING) {
        return next();
      }

      // (1) Absent identity — orphan work.
      if (projectId == null || projectId === "") {
        throw unprocessable(PROJECT_REQUIRED_MESSAGE, {
          error: "project_required",
          field: "projectId",
        });
      }

      // (2) Present but unknown — unresolvable identity.
      const project = await projectsSvc.getById(projectId);
      if (!project) {
        throw unprocessable(projectUnresolvableMessage(projectId), {
          error: "project_unresolvable",
          field: "projectId",
          projectId,
        });
      }

      // Resolved — proceed to the real handler.
      return next();
    };
  };
}
