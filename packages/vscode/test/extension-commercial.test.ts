import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8");

function methodSource(name: string): string {
  const expression = new RegExp(`\\n  private (?:async )?${name}\\(`, "u");
  const match = expression.exec(source);
  assert.ok(match, `missing ${name}`);
  const start = match.index;
  const next = source.indexOf("\n  private ", start + match[0].length);
  return source.slice(start, next === -1 ? source.length : next);
}

test("chat readiness requires authenticated admin runtime and isolates Named tunnel restart", () => {
  const readiness = methodSource("ensureLocalChatRuntime");
  assert.match(readiness, /readAdminStatus\(/);
  assert.match(readiness, /inspectAdminAgentRuntime\(/);
  assert.match(readiness, /waitForAdminRuntime\(/);
  assert.match(readiness, /restartManagedChatServer\(snapshot\)/);
  assert.match(readiness, /isLoopbackPortOccupied\(/);
  assert.doesNotMatch(readiness, /startConfigured\(/);

  const localStart = methodSource("setupChatOnce");
  assert.match(localStart, /ensureLocalChatRuntime\(snapshot\)/);
  assert.doesNotMatch(localStart, /openPanel\(/);
});

test("workspace selection uses real WorkspaceFolder URIs and never process.cwd", () => {
  const scope = methodSource("configurationScope");
  assert.match(scope, /vscode\.workspace\.workspaceFolders/);
  assert.match(scope, /exactFolder\.uri/);
  assert.match(scope, /containingFolder\.uri/);
  assert.doesNotMatch(source, /process\.cwd\(\)/);
  assert.match(methodSource("setupChatOnce"), /selectWorkspace\(undefined, true\)/);
});

test("new chat tombstones the old selection and cancels before stop", () => {
  const newChat = methodSource("newChat");
  assert.match(newChat, /\+\+this\.chatSelectionGeneration/);
  assert.match(newChat, /rememberDismissedChatAgent\(agentId\)/);
  assert.ok(newChat.indexOf("cancelAdminAgentTurn") < newChat.indexOf("stopAdminAgent"));
  assert.match(newChat, /finally \{/);
  assert.match(newChat, /setActiveChatAgent\(undefined, selectionGeneration\)/);

  const state = methodSource("localChatState");
  assert.match(state, /dismissedChatAgentIds\.has/);
  assert.match(state, /selectionGeneration !== this\.chatSelectionGeneration/);
});

test("ChatGPT MCP setup uses the system browser once and daily chat stays in VS Code", () => {
  const browser = methodSource("openIntegratedBrowser");
  assert.match(browser, /workbench\.action\.browser\.open/);
  assert.match(browser, /openToSide: true/);
  assert.match(browser, /reuseUrlFilter\?: string/);
  assert.match(browser, /\.\.\.\(reuseUrlFilter \? \{ reuseUrlFilter \} : \{\}\)/);
  assert.doesNotMatch(browser, /vscode\.env\.openExternal/);
  assert.match(browser, /integrated browser is unavailable/);
  assert.match(browser, /try \{/);
  assert.match(browser, /catch \{/);
  assert.doesNotMatch(browser, /simpleBrowser|webview|iframe/i);

  const connect = methodSource("connectChatGpt");
  assert.match(connect, /state\.externalMcp\.configured/);
  assert.match(connect, /state\.externalMcp\.connected/);
  assert.match(connect, /this\.openChatGpt\("chat"\)/);
  assert.match(connect, /this\.wizard\.resumeRuntime/);
  assert.match(connect, /clipboard\.writeText\(state\.mcpUrl\)/);
  assert.match(connect, /destination: "plugins"/);
  assert.doesNotMatch(connect, /configureAgents/);

  const openChat = methodSource("openChatGptInVsCode");
  assert.match(openChat, /this\.openChatGpt\("chat"\)/);

  const navigate = methodSource("openChatGpt");
  assert.match(navigate, /chatGptNavigation\(destination\)/);
  assert.match(navigate, /navigation\.reuseUrlFilter/);
  assert.doesNotMatch(navigate, /"https:\/\/chatgpt\.com\/\*\*"/);

  const pairing = methodSource("pairWizardOwner");
  assert.match(pairing, /searchParams\.set\("continue", navigation\.url\)/);
  assert.match(pairing, /vscode\.env\.openExternal/);
  assert.doesNotMatch(pairing, /openIntegratedBrowser\(/);
  assert.match(pairing, /After approval, ChatGPT returns inside VS Code automatically/);

  const state = methodSource("dashboardState");
  assert.match(state, /this\.oauthHandoff\.consume/);
  assert.match(state, /handoff\.status === "consumed"/);
  assert.match(state, /void this\.openChatGpt\("chat"\)\.catch/);

  assert.match(pairing, /destination === "plugins"/);
  assert.match(pairing, /this\.oauthHandoff\.begin/);
  assert.match(pairing, /this\.oauthHandoff\.clear/);

  const monitor = methodSource("openCollaborationMonitor");
  assert.match(monitor, /shellArgs: \[cliPath, "chat"\]/);
  assert.match(monitor, /PILINK_CONFIG: snapshot\.configPath/);
  assert.match(monitor, /samePath\(snapshot\.workspace, workspacePath\)/);
  assert.match(monitor, /isPathInside\(snapshot\.workspace, snapshot\.dataDir\)/);
  assert.doesNotMatch(monitor, /configureAgents|setupChat/);
});

test("legacy OAuth deep links cannot route ChatGPT OAuth into the integrated browser", () => {
  const registration = methodSource("registerUriHandler");
  assert.match(registration, /registerUriHandler/);
  assert.match(registration, /handleExternalUri/);

  const handler = methodSource("handleExternalUri");
  assert.match(handler, /uri\.path !== "\/open-oauth"/);
  assert.match(handler, /route is retired/);
  assert.doesNotMatch(handler, /workbench\.action\.browser\.open|simpleBrowser|openExternal/);
  assert.doesNotMatch(source, /private async openOAuthInVsCode/);
});

test("Cloudflare first run provisions a verified private helper before browser login", () => {
  assert.match(source, /from "\.\/cloudflared-bootstrap\.js"/);

  const ensure = methodSource("ensureCloudflaredExecutable");
  assert.match(ensure, /path\.dirname\(snapshot\.configPath\), "bin", "cloudflared"/);
  assert.match(ensure, /provisionManagedCloudflared\(/);
  assert.match(ensure, /MANAGED_CLOUDFLARED_VERSION/);
  assert.match(ensure, /PI_CLOUDFLARED_PATH/);
  assert.match(ensure, /writePrivateFile\(/);

  const login = methodSource("loginCloudflareCredential");
  assert.match(login, /this\.snapshot\(workspace\)/);
  assert.match(login, /await this\.ensureCloudflaredExecutable\(snapshot\)/);
  assert.ok(login.indexOf("ensureCloudflaredExecutable") < login.indexOf("return await loginCloudflare"));

  const named = methodSource("runNamedHostingCli");
  assert.match(named, /await this\.ensureCloudflaredExecutable\(snapshot, command !== "status"\)/);
});

test("ChatGPT setup is gated by the exact final server identity", () => {
  const connect = methodSource("connectChatGpt");
  assert.match(connect, /snapshot = await this\.synchronizeQuickTunnelIdentity\(snapshot\)/);
  assert.match(connect, /snapshot = this\.snapshot\(snapshot\.workspace\)/);
  assert.match(connect, /state\.connectionKey !== snapshot\.connectionKey/);
  assert.match(connect, /state\.connectionFingerprint !== snapshot\.connectionFingerprint/);
  assert.match(connect, /confirmChatGptTarget\(snapshot, state\.publicUrl, state\.mcpUrl\)/);
  assert.ok(connect.indexOf("confirmChatGptTarget") < connect.indexOf("if (state.externalMcp.configured)"));

  const dashboard = methodSource("dashboardState");
  assert.doesNotMatch(dashboard, /capturedPublicUrl/);

  const synchronize = methodSource("synchronizeQuickTunnelIdentity");
  assert.match(synchronize, /readAdminStatus\(snapshot\.port, snapshot\.bootstrapSecret/);
  assert.match(synchronize, /resolveQuickTunnelRuntimeIdentity/);
  assert.match(synchronize, /persistEffectivePublicOrigin/);
  assert.match(synchronize, /await this\.attestWizardEndpoint\(refreshed, resolved\.origin\)/);

  for (const lifecycle of [methodSource("startConfigured"), methodSource("restartConfigured")]) {
    assert.match(lifecycle, /snapshot = await this\.synchronizeQuickTunnelIdentity\(snapshot\)/);
  }

  const confirmation = methodSource("confirmChatGptTarget");
  for (const field of [
    "snapshot.connectionName",
    "snapshot.connectionDescription",
    "snapshot.instanceLabel",
    "snapshot.instanceFingerprint",
    "snapshot.connectionFingerprint",
    "publicUrl",
    "mcpUrl",
    "snapshot.workspace",
  ]) assert.match(confirmation, new RegExp(field.replaceAll(".", "\\."), "u"));
  assert.match(confirmation, /Continue to ChatGPT/);
});

test("guided Full access stays disabled until one exact stable-origin client is authorized", () => {
  const provision = methodSource("provisionWizard");
  assert.match(provision, /accessMode === "full" && hosting\.kind === "quick-tunnel"/);
  assert.match(provision, /removeEnvValue\(contents, "PI_FULL_ACCESS_CLIENT_IDS"\)/);
  assert.match(provision, /updateEnvValue\(contents, "PI_REQUIRE_EXECUTION_APPROVAL", "true"\)/);

  const start = methodSource("startWizardRuntime");
  assert.match(start, /const args = \[plan\.command\]/);
  assert.doesNotMatch(start, /allow-unsafe-full-access/);

  const binding = methodSource("ensureWizardFullAccessBinding");
  assert.match(binding, /selectPendingFullAccessClient\(/);
  assert.match(binding, /accessMode: wizard\.accessMode/);
  assert.match(binding, /publicOrigin: snapshot\.serverUrl/);
  assert.match(binding, /selection\.status === "ambiguous"/);
  assert.match(binding, /PI_REQUIRE_EXECUTION_APPROVAL === "true"/);

  const activation = methodSource("applyFullAccessClient");
  assert.match(activation, /writeFullAccessConfiguration\(snapshot, clientId, true\)/);
  assert.match(activation, /hosting\.kind === "quick-tunnel"/);
  assert.match(activation, /restartManagedChatServer/);
  assert.match(activation, /waitForHealth/);
});
