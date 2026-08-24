import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { managedNodeAsset, provisionManagedNodeRuntime } from "../src/node-bootstrap.js";

test("managed Node assets are release-pinned for supported Remote SSH hosts", () => {
  const linux = managedNodeAsset("linux", "x64");
  assert.equal(linux.archiveName, "node-v24.18.0-linux-x64.tar.xz");
  assert.match(linux.expectedSha256, /^[a-f0-9]{64}$/u);
  assert.equal(managedNodeAsset("linux", "arm64").archiveKind, "tar.xz");
  assert.equal(managedNodeAsset("darwin", "x64").archiveKind, "tar.gz");
  assert.throws(() => managedNodeAsset("win32", "x64"), /unsupported/u);
});

test("provisioning rejects an archive before extraction when the pinned hash differs", async (t) => {
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "vspilink-node-bootstrap-test-"));
  t.after(() => fs.rmSync(dataHome, { recursive: true, force: true }));
  let extracted = false;
  await assert.rejects(
    provisionManagedNodeRuntime({
      platform: "linux",
      arch: "x64",
      dataHome,
      fetch: async () => new Response("not the official archive", {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
      extractArchive: () => { extracted = true; },
      detectVersion: () => "",
    }),
    /pinned SHA-256/u,
  );
  assert.equal(extracted, false);
});
