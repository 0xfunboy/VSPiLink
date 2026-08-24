import fs from "node:fs";
import path from "node:path";

export type PrivateStateField = "configPath" | "dataDir" | "coordinationDir";

export type PrivateStateBoundaryViolationCode =
  | "invalid-path"
  | "path-unresolvable"
  | "capability-root-missing"
  | "capability-root-not-directory"
  | "wrong-path-type"
  | "inside-capability-root";

export interface PrivateStateBoundaryInput {
  /** The directory exposed to MCP file and command capabilities. */
  readonly capabilityRoot: string;
  /** Private environment/configuration file, whether or not it exists yet. */
  readonly configPath: string;
  /** Durable OAuth and server state directory. */
  readonly dataDir: string;
  /** Private agent coordination state directory. */
  readonly coordinationDir: string;
}

export interface CanonicalPrivateStatePaths {
  readonly capabilityRoot: string;
  readonly configPath: string;
  readonly dataDir: string;
  readonly coordinationDir: string;
}

type MutableCanonicalPrivateStatePaths = {
  -readonly [Field in keyof CanonicalPrivateStatePaths]?: CanonicalPrivateStatePaths[Field];
};

export interface PrivateStateBoundaryViolation {
  readonly field: "capabilityRoot" | PrivateStateField;
  readonly code: PrivateStateBoundaryViolationCode;
  readonly message: string;
  readonly configuredPath: string;
  readonly canonicalPath?: string;
}

export type PrivateStateBoundaryResult =
  | {
      readonly ok: true;
      readonly paths: CanonicalPrivateStatePaths;
      readonly violations: readonly [];
    }
  | {
      readonly ok: false;
      readonly paths: Partial<CanonicalPrivateStatePaths>;
      readonly violations: readonly PrivateStateBoundaryViolation[];
    };

interface ResolvedPotentialPath {
  readonly configuredPath: string;
  readonly absolutePath: string;
  readonly canonicalPath: string;
  readonly exists: boolean;
  readonly kind: "directory" | "file" | "other" | "missing";
}

class PotentialPathResolutionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PotentialPathResolutionError";
  }
}

/** Error thrown by {@link assertPrivateStateBoundary}. */
export class PrivateStateBoundaryError extends Error {
  public readonly violations: readonly PrivateStateBoundaryViolation[];

  public constructor(violations: readonly PrivateStateBoundaryViolation[]) {
    super(violations.map((violation) => violation.message).join(" "));
    this.name = "PrivateStateBoundaryError";
    this.violations = violations;
  }
}

/**
 * Validates that no private state path is the capability root or one of its
 * descendants. Both the configured spelling and the canonical filesystem
 * target are checked, so a symlink cannot hide either direction of escape.
 *
 * Paths that do not exist yet are resolved through their nearest existing
 * parent. This allows a first-run wizard to validate future directories while
 * still honoring every symlink in the existing prefix.
 */
export function validatePrivateStateBoundary(
  input: PrivateStateBoundaryInput,
): PrivateStateBoundaryResult {
  const violations: PrivateStateBoundaryViolation[] = [];
  const paths: MutableCanonicalPrivateStatePaths = {};

  const root = resolveField("capabilityRoot", input.capabilityRoot, violations);
  let validRoot: ResolvedPotentialPath | undefined;
  if (root) {
    paths.capabilityRoot = root.canonicalPath;
    if (!root.exists) {
      violations.push({
        field: "capabilityRoot",
        code: "capability-root-missing",
        configuredPath: root.configuredPath,
        canonicalPath: root.canonicalPath,
        message: `Capability root does not exist: ${root.configuredPath}. Select an existing workspace folder.`,
      });
    } else if (root.kind !== "directory") {
      violations.push({
        field: "capabilityRoot",
        code: "capability-root-not-directory",
        configuredPath: root.configuredPath,
        canonicalPath: root.canonicalPath,
        message: `Capability root must be a directory: ${root.configuredPath}.`,
      });
    } else {
      validRoot = root;
    }
  }

  for (const field of ["configPath", "dataDir", "coordinationDir"] as const) {
    const candidate = resolveField(field, input[field], violations);
    if (!candidate) continue;
    paths[field] = candidate.canonicalPath;

    const expectedKind = field === "configPath" ? "file" : "directory";
    if (candidate.exists && candidate.kind !== expectedKind) {
      violations.push({
        field,
        code: "wrong-path-type",
        configuredPath: candidate.configuredPath,
        canonicalPath: candidate.canonicalPath,
        message: field === "configPath"
          ? `configPath must identify a file, not a ${candidate.kind}: ${candidate.configuredPath}.`
          : `${field} must identify a directory, not a ${candidate.kind}: ${candidate.configuredPath}.`,
      });
    }

    if (validRoot) {
      const lexicalInside = isWithinOrEqual(validRoot.absolutePath, candidate.absolutePath);
      const canonicalInside = isWithinOrEqual(validRoot.canonicalPath, candidate.canonicalPath);
      if (lexicalInside || canonicalInside) {
        violations.push(boundaryViolation(field, candidate, validRoot, lexicalInside, canonicalInside));
      }
    }
  }

  if (violations.length > 0) return { ok: false, paths, violations };
  return {
    ok: true,
    paths: paths as CanonicalPrivateStatePaths,
    violations: [],
  };
}

/** Validates the boundary and returns canonical paths, or throws all errors. */
export function assertPrivateStateBoundary(
  input: PrivateStateBoundaryInput,
): CanonicalPrivateStatePaths {
  const result = validatePrivateStateBoundary(input);
  if (!result.ok) throw new PrivateStateBoundaryError(result.violations);
  return result.paths;
}

/**
 * Reject a secret-bearing regular file when either its configured spelling or
 * canonical target is exposed by the selected MCP workspace.
 */
export function assertPrivateCredentialOutsideCapabilityRoot(
  capabilityRoot: string,
  credentialPath: string,
): string {
  const root = resolvePotentialPath(capabilityRoot, "capabilityRoot");
  const credential = resolvePotentialPath(credentialPath, "configPath");
  if (!root.exists || root.kind !== "directory") {
    throw new Error(`Capability root must be an existing directory: ${capabilityRoot}.`);
  }
  if (!credential.exists || credential.kind !== "file") {
    throw new Error(`Cloudflare credential must be an existing regular file: ${credentialPath}.`);
  }
  const stat = fs.lstatSync(credential.absolutePath);
  if (stat.isSymbolicLink()) throw new Error("Cloudflare credential must not be a symbolic link.");
  if (
    isWithinOrEqual(root.absolutePath, credential.absolutePath) ||
    isWithinOrEqual(root.canonicalPath, credential.canonicalPath)
  ) {
    throw new Error("Cloudflare credentials must be stored outside the MCP workspace.");
  }
  return credential.canonicalPath;
}

function resolveField(
  field: "capabilityRoot" | PrivateStateField,
  configuredPath: string,
  violations: PrivateStateBoundaryViolation[],
): ResolvedPotentialPath | undefined {
  try {
    return resolvePotentialPath(configuredPath, field);
  } catch (error) {
    const code = error instanceof PotentialPathResolutionError && /must be an absolute|must be a non-empty|NUL/u.test(error.message)
      ? "invalid-path"
      : "path-unresolvable";
    violations.push({
      field,
      code,
      configuredPath,
      message: error instanceof Error ? error.message : `Could not resolve ${field}: ${configuredPath}.`,
    });
    return undefined;
  }
}

function resolvePotentialPath(
  configuredPath: string,
  field: "capabilityRoot" | PrivateStateField,
): ResolvedPotentialPath {
  if (typeof configuredPath !== "string" || configuredPath.trim().length === 0) {
    throw new PotentialPathResolutionError(`${field} must be a non-empty absolute path.`);
  }
  if (configuredPath.includes("\0")) {
    throw new PotentialPathResolutionError(`${field} must not contain a NUL byte.`);
  }
  if (!path.isAbsolute(configuredPath)) {
    throw new PotentialPathResolutionError(`${field} must be an absolute path: ${configuredPath}.`);
  }

  const absolutePath = path.resolve(configuredPath);
  const missingSegments: string[] = [];
  let cursor = absolutePath;

  for (;;) {
    try {
      const canonicalParent = fs.realpathSync.native(cursor);
      const stats = statResolvedPath(canonicalParent, field, configuredPath);
      if (missingSegments.length > 0 && !stats.isDirectory()) {
        throw new PotentialPathResolutionError(
          `${field} cannot be created because its nearest existing parent is not a directory: ${cursor}.`,
        );
      }
      const canonicalPath = missingSegments.length > 0
        ? path.join(canonicalParent, ...missingSegments)
        : canonicalParent;
      return {
        configuredPath,
        absolutePath,
        canonicalPath: path.resolve(canonicalPath),
        exists: missingSegments.length === 0,
        kind: missingSegments.length > 0
          ? "missing"
          : stats.isDirectory()
            ? "directory"
            : stats.isFile()
              ? "file"
              : "other",
      };
    } catch (error) {
      if (error instanceof PotentialPathResolutionError) throw error;
      const filesystemError = error as NodeJS.ErrnoException;
      const link = lstatIfPresent(cursor, field, configuredPath);
      if (link?.isSymbolicLink()) {
        throw new PotentialPathResolutionError(
          `${field} contains a dangling, cyclic, or otherwise unresolvable symbolic link: ${cursor}.`,
        );
      }
      if (!isMissingPathError(filesystemError)) {
        throw new PotentialPathResolutionError(
          `Could not resolve ${field} at ${cursor}: ${cleanFilesystemMessage(filesystemError)}.`,
        );
      }

      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new PotentialPathResolutionError(
          `Could not find an existing parent for ${field}: ${configuredPath}.`,
        );
      }
      missingSegments.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function statResolvedPath(
  canonicalPath: string,
  field: "capabilityRoot" | PrivateStateField,
  configuredPath: string,
): fs.Stats {
  try {
    return fs.statSync(canonicalPath);
  } catch (error) {
    throw new PotentialPathResolutionError(
      `Could not inspect ${field} at ${configuredPath}: ${cleanFilesystemMessage(error as NodeJS.ErrnoException)}.`,
    );
  }
}

function lstatIfPresent(
  candidate: string,
  field: "capabilityRoot" | PrivateStateField,
  configuredPath: string,
): fs.Stats | undefined {
  try {
    return fs.lstatSync(candidate);
  } catch (error) {
    const filesystemError = error as NodeJS.ErrnoException;
    if (isMissingPathError(filesystemError)) return undefined;
    throw new PotentialPathResolutionError(
      `Could not inspect ${field} at ${configuredPath}: ${cleanFilesystemMessage(filesystemError)}.`,
    );
  }
}

function boundaryViolation(
  field: PrivateStateField,
  candidate: ResolvedPotentialPath,
  root: ResolvedPotentialPath,
  lexicalInside: boolean,
  canonicalInside: boolean,
): PrivateStateBoundaryViolation {
  let reason = "the path is inside the capability root";
  if (!lexicalInside && canonicalInside) {
    reason = "the path resolves inside the capability root through a symbolic link";
  } else if (lexicalInside && !canonicalInside) {
    reason = "the path is addressed from inside the capability root and could expose its target through a symbolic link";
  }
  return {
    field,
    code: "inside-capability-root",
    configuredPath: candidate.configuredPath,
    canonicalPath: candidate.canonicalPath,
    message: `${field} must be outside capability root ${root.configuredPath}; ${reason}: ${candidate.configuredPath} (canonical: ${candidate.canonicalPath}).`,
  };
}

function isWithinOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isMissingPathError(error: NodeJS.ErrnoException): boolean {
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function cleanFilesystemMessage(error: NodeJS.ErrnoException): string {
  return (error.message || error.code || "filesystem error")
    .replace(/[\r\n\0]+/g, " ")
    .slice(0, 500);
}
