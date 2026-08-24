import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MANAGED_CLOUDFLARED_VERSION,
  managedCloudflaredAsset,
  managedCloudflaredCandidateMatches,
  provisionManagedCloudflared,
} from "../src/cloudflared-bootstrap.js";

function privateTestDirectory(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vspilink-cloudflared-bootstrap-"));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function responseWithUrl(body: BodyInit, url: string): Response {
  const response = new Response(body, {
    status: 200,
    headers: { "content-type": "application/octet-stream" },
  });
  Object.defineProperty(response, "url", { configurable: true, value: url });
  return response;
}

test("managed cloudflared assets match the CLI-pinned Linux release matrix", () => {
  const x64 = managedCloudflaredAsset("linux", "x64");
  const arm64 = managedCloudflaredAsset("linux", "arm64");
  assert.equal(x64.version, "2026.7.2");
  assert.equal(x64.assetName, "cloudflared-linux-amd64");
  assert.equal(x64.expectedSha256, "ec905ea7b7e327ff8abdde8cb64697a2152de74dbcdbf6aec9db8364eb3886cd");
  assert.equal(arm64.assetName, "cloudflared-linux-arm64");
  assert.equal(arm64.expectedSha256, "405df476437e027fc6d18729a5a77155c0a33a6082aeee60a799a688f3052e66");
  assert.equal(MANAGED_CLOUDFLARED_VERSION, x64.version);
  assert.throws(() => managedCloudflaredAsset("darwin", "x64"), /unsupported/u);
  assert.throws(() => managedCloudflaredAsset("linux", "ia32"), /unsupported/u);
});

test("only an exact pinned, owner-only executable and version qualifies for reuse", () => {
  const asset = managedCloudflaredAsset("linux", "x64");
  const valid = {
    sha256: asset.expectedSha256,
    detectedVersion: `cloudflared version ${asset.version} (built for release)`,
    mode: 0o100700,
  };
  assert.equal(managedCloudflaredCandidateMatches(asset, valid), true);
  assert.equal(managedCloudflaredCandidateMatches(asset, { ...valid, sha256: "0".repeat(64) }), false);
  assert.equal(managedCloudflaredCandidateMatches(asset, { ...valid, detectedVersion: "cloudflared version 2026.7.1" }), false);
  assert.equal(managedCloudflaredCandidateMatches(asset, { ...valid, mode: 0o100600 }), false);
  assert.equal(managedCloudflaredCandidateMatches(asset, { ...valid, mode: 0o100722 }), false);
});

test("a failed checksum never replaces the existing destination", async (t) => {
  const root = privateTestDirectory(t);
  const destination = path.join(root, "cloudflared");
  fs.writeFileSync(destination, "previous managed candidate", { mode: 0o700 });
  const asset = managedCloudflaredAsset("linux", "x64");
  let probes = 0;

  await assert.rejects(
    provisionManagedCloudflared({
      destination,
      platform: "linux",
      arch: "x64",
      fetch: async () => responseWithUrl("not the pinned release", asset.downloadUrl),
      detectVersion: () => {
        probes += 1;
        return `cloudflared version ${asset.version}`;
      },
    }),
    /pinned SHA-256/u,
  );

  assert.equal(probes, 0, "unverified bytes must never be executed");
  assert.equal(fs.readFileSync(destination, "utf8"), "previous managed candidate");
  assert.deepEqual(fs.readdirSync(root), ["cloudflared"]);
});

test("a destination symlink is rejected before network access", async (t) => {
  const root = privateTestDirectory(t);
  const target = path.join(root, "target");
  const destination = path.join(root, "cloudflared");
  fs.writeFileSync(target, "do not replace", { mode: 0o600 });
  fs.symlinkSync(target, destination);
  let fetched = false;

  await assert.rejects(
    provisionManagedCloudflared({
      destination,
      platform: "linux",
      arch: "x64",
      fetch: async () => {
        fetched = true;
        return new Response("unexpected");
      },
      detectVersion: () => `cloudflared version ${MANAGED_CLOUDFLARED_VERSION}`,
    }),
    /non-symlink regular file/u,
  );

  assert.equal(fetched, false);
  assert.equal(fs.readFileSync(target, "utf8"), "do not replace");
  assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
});

test("a symlinked managed directory is rejected", async (t) => {
  const root = privateTestDirectory(t);
  const realDirectory = path.join(root, "real");
  const linkedDirectory = path.join(root, "linked");
  fs.mkdirSync(realDirectory, { mode: 0o700 });
  fs.symlinkSync(realDirectory, linkedDirectory, "dir");

  await assert.rejects(
    provisionManagedCloudflared({
      destination: path.join(linkedDirectory, "cloudflared"),
      platform: "linux",
      arch: "x64",
      fetch: async () => new Response("unexpected"),
      detectVersion: () => "",
    }),
    /real directory|symbolic links/u,
  );
});

test("an unapproved final download host is rejected without promotion", async (t) => {
  const root = privateTestDirectory(t);
  const destination = path.join(root, "cloudflared");
  const asset = managedCloudflaredAsset("linux", "arm64");

  await assert.rejects(
    provisionManagedCloudflared({
      destination,
      platform: "linux",
      arch: "arm64",
      fetch: async () => responseWithUrl("untrusted", "https://downloads.example.invalid/cloudflared"),
      detectVersion: () => `cloudflared version ${asset.version}`,
    }),
    /approved release hosts/u,
  );

  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(fs.readdirSync(root), []);
});
