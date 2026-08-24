import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  assertPrivateCredentialOutsideCapabilityRoot,
  assertPrivateStateBoundary,
  PrivateStateBoundaryError,
  validatePrivateStateBoundary,
} from "../src/private-state-boundary.js";

function fixture(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vspilink-private-boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function directorySymlink(target: string, linkPath: string): void {
  fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

test("canonicalizes not-yet-created private paths through their nearest existing parent", (t) => {
  const root = fixture(t);
  const workspace = path.join(root, "workspace");
  const privateParent = path.join(root, "private-real");
  const privateAlias = path.join(root, "private-alias");
  fs.mkdirSync(workspace);
  fs.mkdirSync(privateParent);
  directorySymlink(privateParent, privateAlias);

  const paths = assertPrivateStateBoundary({
    capabilityRoot: workspace,
    configPath: path.join(privateAlias, "new", "vspilink.env"),
    dataDir: path.join(privateAlias, "new", "data"),
    coordinationDir: path.join(privateAlias, "runtime", "coordination"),
  });

  assert.equal(paths.capabilityRoot, fs.realpathSync(workspace));
  assert.equal(paths.configPath, path.join(fs.realpathSync(privateParent), "new", "vspilink.env"));
  assert.equal(paths.dataDir, path.join(fs.realpathSync(privateParent), "new", "data"));
  assert.equal(paths.coordinationDir, path.join(fs.realpathSync(privateParent), "runtime", "coordination"));
});

test("rejects equality and true child paths for every private field", (t) => {
  const root = fixture(t);
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);

  const result = validatePrivateStateBoundary({
    capabilityRoot: workspace,
    configPath: path.join(workspace, ".vspilink.env"),
    dataDir: workspace,
    coordinationDir: path.join(workspace, "private", "coordination"),
  });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected private state inside the workspace to be rejected");
  assert.deepEqual(
    result.violations
      .filter(({ code }) => code === "inside-capability-root")
      .map(({ field }) => field)
      .sort(),
    ["configPath", "coordinationDir", "dataDir"],
  );
  assert.ok(result.violations.every(({ message }) => message.length > 0));
});

test("uses path-segment boundaries rather than string prefixes", (t) => {
  const root = fixture(t);
  const workspace = path.join(root, "workspace");
  const similarlyNamedSibling = path.join(root, "workspace-private");
  fs.mkdirSync(workspace);
  fs.mkdirSync(similarlyNamedSibling);

  const result = validatePrivateStateBoundary({
    capabilityRoot: workspace,
    configPath: path.join(similarlyNamedSibling, "vspilink.env"),
    dataDir: root,
    coordinationDir: path.join(similarlyNamedSibling, "coordination"),
  });

  assert.equal(result.ok, true);
});

test("rejects a lexical path outside the root when a symlink resolves it inside", (t) => {
  const root = fixture(t);
  const workspace = path.join(root, "workspace");
  const alias = path.join(root, "workspace-alias");
  fs.mkdirSync(workspace);
  directorySymlink(workspace, alias);

  const result = validatePrivateStateBoundary({
    capabilityRoot: workspace,
    configPath: path.join(root, "private", "vspilink.env"),
    dataDir: path.join(alias, "not-created", "data"),
    coordinationDir: path.join(root, "runtime", "coordination"),
  });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected symlinked state inside the workspace to be rejected");
  const violation = result.violations.find(({ field }) => field === "dataDir");
  assert.equal(violation?.code, "inside-capability-root");
  assert.match(violation?.message || "", /resolves inside.*symbolic link/i);
  assert.equal(violation?.canonicalPath, path.join(fs.realpathSync(workspace), "not-created", "data"));
});

test("rejects an inside-root symlink alias even when its target is outside", (t) => {
  const root = fixture(t);
  const workspace = path.join(root, "workspace");
  const privateDirectory = path.join(root, "private");
  const insideAlias = path.join(workspace, "private-alias");
  fs.mkdirSync(workspace);
  fs.mkdirSync(privateDirectory);
  directorySymlink(privateDirectory, insideAlias);

  const result = validatePrivateStateBoundary({
    capabilityRoot: workspace,
    configPath: path.join(root, "config", "vspilink.env"),
    dataDir: path.join(insideAlias, "data"),
    coordinationDir: path.join(root, "runtime", "coordination"),
  });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected an alias reachable inside the workspace to be rejected");
  const violation = result.violations.find(({ field }) => field === "dataDir");
  assert.equal(violation?.code, "inside-capability-root");
  assert.match(violation?.message || "", /addressed from inside.*symbolic link/i);
});

test("a symlinked capability root is compared by its canonical target", (t) => {
  const root = fixture(t);
  const workspace = path.join(root, "workspace-real");
  const workspaceAlias = path.join(root, "workspace-alias");
  fs.mkdirSync(workspace);
  directorySymlink(workspace, workspaceAlias);

  const result = validatePrivateStateBoundary({
    capabilityRoot: workspaceAlias,
    configPath: path.join(workspace, "private.env"),
    dataDir: path.join(root, "private", "data"),
    coordinationDir: path.join(root, "runtime", "coordination"),
  });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected the real workspace child to be rejected");
  assert.equal(
    result.violations.find(({ field }) => field === "configPath")?.code,
    "inside-capability-root",
  );
});

test("reports clear errors for a non-directory parent and a dangling symlink", (t) => {
  const root = fixture(t);
  const workspace = path.join(root, "workspace");
  const existingFile = path.join(root, "existing-file");
  const danglingLink = path.join(root, "dangling-link");
  fs.mkdirSync(workspace);
  fs.writeFileSync(existingFile, "not a directory");
  fs.symlinkSync(path.join(root, "missing-target"), danglingLink);

  const result = validatePrivateStateBoundary({
    capabilityRoot: workspace,
    configPath: path.join(root, "config", "vspilink.env"),
    dataDir: path.join(existingFile, "data"),
    coordinationDir: path.join(danglingLink, "coordination"),
  });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected unresolvable private paths to fail");
  assert.match(
    result.violations.find(({ field }) => field === "dataDir")?.message || "",
    /nearest existing parent is not a directory/i,
  );
  assert.match(
    result.violations.find(({ field }) => field === "coordinationDir")?.message || "",
    /unresolvable symbolic link/i,
  );
});

test("assertion errors retain structured violations and actionable messages", (t) => {
  const root = fixture(t);
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);

  assert.throws(
    () => assertPrivateStateBoundary({
      capabilityRoot: workspace,
      configPath: path.join(workspace, "vspilink.env"),
      dataDir: path.join(root, "private", "data"),
      coordinationDir: path.join(root, "runtime", "coordination"),
    }),
    (error: unknown) => {
      assert.ok(error instanceof PrivateStateBoundaryError);
      assert.equal(error.violations[0]?.field, "configPath");
      assert.match(error.message, /configPath must be outside capability root/i);
      return true;
    },
  );
});

test("requires the capability root to exist and be a directory", (t) => {
  const root = fixture(t);
  const missingWorkspace = path.join(root, "missing-workspace");

  const missing = validatePrivateStateBoundary({
    capabilityRoot: missingWorkspace,
    configPath: path.join(root, "config", "vspilink.env"),
    dataDir: path.join(root, "private", "data"),
    coordinationDir: path.join(root, "runtime", "coordination"),
  });
  assert.equal(missing.ok, false);
  if (missing.ok) assert.fail("expected a missing capability root to fail");
  assert.equal(missing.violations[0]?.code, "capability-root-missing");
  assert.match(missing.violations[0]?.message || "", /select an existing workspace folder/i);

  const rootFile = path.join(root, "workspace-file");
  fs.writeFileSync(rootFile, "not a workspace");
  const file = validatePrivateStateBoundary({
    capabilityRoot: rootFile,
    configPath: path.join(root, "config", "vspilink.env"),
    dataDir: path.join(root, "private", "data"),
    coordinationDir: path.join(root, "runtime", "coordination"),
  });
  assert.equal(file.ok, false);
  if (file.ok) assert.fail("expected a file capability root to fail");
  assert.equal(file.violations[0]?.code, "capability-root-not-directory");
});

test("Cloudflare credentials must be regular files outside the MCP workspace", (t) => {
  const root = fixture(t);
  const workspace = path.join(root, "workspace");
  const privateDirectory = path.join(root, "private");
  fs.mkdirSync(workspace);
  fs.mkdirSync(privateDirectory);
  const inside = path.join(workspace, "cert.pem");
  const outside = path.join(privateDirectory, "cert.pem");
  fs.writeFileSync(inside, "inside");
  fs.writeFileSync(outside, "outside");

  assert.throws(
    () => assertPrivateCredentialOutsideCapabilityRoot(workspace, inside),
    /outside the MCP workspace/u,
  );
  assert.equal(
    assertPrivateCredentialOutsideCapabilityRoot(workspace, outside),
    fs.realpathSync(outside),
  );

  const link = path.join(privateDirectory, "linked-cert.pem");
  fs.symlinkSync(outside, link);
  assert.throws(
    () => assertPrivateCredentialOutsideCapabilityRoot(workspace, link),
    /must not be a symbolic link/u,
  );
});
