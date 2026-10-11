import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { SessionInboundMessageSchema } from "@getpaseo/protocol/messages";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { runAllowCommand } from "./allow.js";
import { runDenyCommand } from "./deny.js";

const agentId = "2d85f428-fdaf-4d98-906f-c583de2b805f";
const requests: AgentPermissionRequest[] = [
  { id: "permission-write", provider: "codex", name: "CodexBash", kind: "tool" },
  { id: "permission-edit", provider: "codex", name: "CodexBash", kind: "tool" },
];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Protocol peer that holds permission replies until the test resolves them. */
async function createDaemonPeer() {
  const home = await mkdtemp(join(tmpdir(), "paseo-permit-response-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  cleanups.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing peer port");
  const responses = new Map<string, () => void>();
  const received = new Set<string>();
  const pending = [...requests];
  let notifyReceived = () => {};
  let closed = false;

  function emit(socket: WebSocket, message: unknown) {
    socket.send(JSON.stringify({ type: "session", message }));
  }
  function receive(socket: WebSocket, raw: string) {
    const frame = JSON.parse(raw);
    if (frame.type === "ping") {
      socket.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (frame.type === "hello") {
      emit(socket, {
        type: "status",
        payload: {
          status: "server_info",
          serverId: "srv_permit_test",
          hostname: null,
          version: null,
          features: { ownedSubscriptions: true },
        },
      });
      return;
    }
    if (frame.type !== "session") return;
    const message = SessionInboundMessageSchema.parse(frame.message);
    if (message.type === "fetch_agent_request") {
      emit(socket, {
        type: "fetch_agent_response",
        payload: {
          requestId: message.requestId,
          error: null,
          agent: {
            id: agentId,
            provider: "codex",
            cwd: "/tmp/project",
            model: null,
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T00:00:00.000Z",
            lastUserMessageAt: null,
            status: "running",
            capabilities: {
              supportsStreaming: true,
              supportsSessionPersistence: false,
              supportsDynamicModes: false,
              supportsMcpServers: false,
              supportsReasoningStream: false,
              supportsToolInvocations: true,
            },
            currentModeId: null,
            availableModes: [],
            pendingPermissions: pending,
            persistence: null,
            title: null,
          },
        },
      });
    }
    if (message.type === "agent_permission_response") {
      responses.set(message.requestId, () => {
        pending.splice(
          pending.findIndex((request) => request.id === message.requestId),
          1,
        );
        emit(socket, {
          type: "agent_permission_resolved",
          payload: {
            agentId: message.agentId,
            requestId: message.requestId,
            resolution: message.response,
          },
        });
      });
      received.add(message.requestId);
      notifyReceived();
    }
  }
  server.on("connection", (socket) => {
    socket.on("message", (raw) => receive(socket, raw.toString()));
    socket.on("close", () => {
      closed = true;
    });
  });
  async function waitForResponses(count: number) {
    while (received.size < count) {
      await new Promise<void>((resolve) => {
        notifyReceived = resolve;
      });
    }
  }
  function resolvePermission(requestId: string) {
    const respond = responses.get(requestId);
    if (!respond) throw new Error(`Response not received: ${requestId}`);
    respond();
  }
  return {
    options: { daemonTarget: { kind: "endpoint" as const, host: `127.0.0.1:${address.port}` } },
    pending,
    waitForResponses,
    resolve: resolvePermission,
    isClosed: () => closed,
  };
}

const actions = [
  { name: "allow", run: runAllowCommand, result: "allowed" },
  { name: "deny", run: runDenyCommand, result: "denied" },
];
for (const action of actions) {
  describe(`permit ${action.name}`, () => {
    it("keeps the connection open and returns success only after resolution", async () => {
      const peer = await createDaemonPeer();
      let completed = false;
      const command = action.run(agentId, requests[0].id, peer.options, new Command());
      void command.then(
        () => (completed = true),
        () => false,
      );
      await peer.waitForResponses(1);
      expect(completed).toBe(false);
      expect(peer.isClosed()).toBe(false);
      expect(peer.pending).toEqual(requests);
      peer.resolve(requests[0].id);
      const result = await command;
      expect(result.data).toEqual([
        {
          requestId: requests[0].id,
          agentId,
          agentShortId: agentId.slice(0, 7),
          name: "CodexBash",
          result: action.result,
        },
      ]);
      expect(peer.pending).toEqual([requests[1]]);
    });
    it("waits for every resolution with --all", async () => {
      const peer = await createDaemonPeer();
      let completed = false;
      const command = action.run(agentId, undefined, { ...peer.options, all: true }, new Command());
      void command.then(
        () => (completed = true),
        () => false,
      );
      await peer.waitForResponses(2);
      peer.resolve(requests[0].id);
      expect(completed).toBe(false);
      expect(peer.isClosed()).toBe(false);
      peer.resolve(requests[1].id);
      const result = await command;
      expect(result.data.map((item) => item.result)).toEqual([action.result, action.result]);
      expect(peer.pending).toEqual([]);
    });
    it("rejects an unconfirmed response without returning success", async () => {
      const peer = await createDaemonPeer();
      const command = action.run(agentId, requests[0].id, peer.options, new Command());
      await expect(command).rejects.toMatchObject({
        code: "PERMISSION_RESPONSE_UNCONFIRMED",
        message: expect.stringContaining(requests[0].id),
        details: 'Use "paseo permit ls" to check whether the request is still pending',
      });
      expect(peer.pending).toEqual(requests);
    }, 20_000);
  });
}
