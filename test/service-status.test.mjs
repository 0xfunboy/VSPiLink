import assert from "node:assert/strict";
import test from "node:test";

import {
  recordMcpInitialized,
  serviceActivitySnapshot,
  setActiveMcpSessions,
} from "../dist/service-status.js";

test("ChatGPT activity excludes native MCP clients and stops when its sessions close", () => {
  const nativeClient = "pi_native_status_01";
  const chatGptClient = "pi_chatgpt_status_01";

  recordMcpInitialized(nativeClient, false);
  setActiveMcpSessions(nativeClient, 2, false);
  assert.equal(serviceActivitySnapshot().chatgptConnected, false);
  assert.equal(serviceActivitySnapshot().chatgptActiveSessions, 0);

  recordMcpInitialized(chatGptClient, true);
  setActiveMcpSessions(chatGptClient, 1, true);
  assert.equal(serviceActivitySnapshot().chatgptConnected, true);
  assert.equal(serviceActivitySnapshot().chatgptActiveSessions, 1);

  setActiveMcpSessions(chatGptClient, 0, true);
  const disconnected = serviceActivitySnapshot();
  assert.equal(disconnected.chatgptConnected, false);
  assert.equal(disconnected.chatgptActiveSessions, 0);
  assert.equal(disconnected.clients.find((client) => client.chatGpt)?.activeMcpSessions, 0);
});
