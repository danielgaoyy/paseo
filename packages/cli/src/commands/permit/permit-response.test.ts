import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { DaemonTransport } from "@getpaseo/client/internal/daemon-client-transport-types";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { SessionInboundMessageSchema } from "@getpaseo/protocol/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createPermitCommand } from "./index.js";

const mocks = vi.hoisted(() => ({ connectToDaemon: vi.fn() }));
vi.mock("../../utils/client.js", () => ({ connectToDaemon: mocks.connectToDaemon }));

const agentId = "2d85f428-fdaf-4d98-906f-c583de2b805f";
const requests: AgentPermissionRequest[] = [
  { id: "permission-write", provider: "claude", name: "Write", kind: "tool" },
  { id: "permission-edit", provider: "claude", name: "Edit", kind: "tool" },
];
const clientFrameSchema = z.object({
  type: z.string(),
  message: SessionInboundMessageSchema.optional(),
});
const clients: DaemonClient[] = [];

async function createDelayedDaemon(acknowledge = true) {
  let onMessage: Parameters<DaemonTransport["onMessage"]>[0] = () => {};
  let onOpen: Parameters<DaemonTransport["onOpen"]>[0] = () => {};
  let closed = false;
  const pending = [...requests];
  const delivered: Array<
    Extract<z.infer<typeof SessionInboundMessageSchema>, { type: "agent_permission_response" }>
  > = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];

  function emit(message: unknown) {
    onMessage(JSON.stringify({ type: "session", message }), false);
  }

  const transport: DaemonTransport = {
    send(data) {
      if (typeof data !== "string") return;
      const frame = clientFrameSchema.parse(JSON.parse(data));
      if (frame.type === "ping") {
        onMessage(JSON.stringify({ type: "pong" }), false);
        return;
      }
      const message = frame.message;
      if (!message) return;
      if (message.type === "fetch_agent_request") {
        emit({
          type: "fetch_agent_response",
          payload: {
            requestId: message.requestId,
            error: null,
            agent: {
              id: agentId,
              provider: "claude",
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
        const delay = message.requestId === "permission-write" ? 100 : 200;
        timers.push(
          setTimeout(() => {
            delivered.push(message);
            const index = pending.findIndex((request) => request.id === message.requestId);
            pending.splice(index, 1);
            if (acknowledge) {
              emit({
                type: "agent_permission_resolved",
                payload: {
                  agentId: message.agentId,
                  requestId: message.requestId,
                  resolution: message.response,
                },
              });
            }
          }, delay),
        );
      }
    },
    close() {
      closed = true;
      timers.forEach(clearTimeout);
    },
    onMessage(handler) {
      onMessage = handler;
      return () => {};
    },
    onOpen(handler) {
      onOpen = handler;
      return () => {};
    },
    onClose: () => () => {},
    onError: () => () => {},
  };
  const client = new DaemonClient({
    url: "ws://test",
    clientId: "cli-permit-test",
    reconnect: { enabled: false },
    transportFactory: () => transport,
  });
  clients.push(client);
  const connecting = client.connect();
  onOpen();
  emit({
    type: "status",
    payload: {
      status: "server_info",
      serverId: "srv_permit_test",
      hostname: null,
      version: null,
      features: { ownedSubscriptions: true },
    },
  });
  await connecting;
  mocks.connectToDaemon.mockResolvedValue(client);
  return { client, delivered, pending, isClosed: () => closed };
}

describe("permit response acknowledgement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.connectToDaemon.mockReset();
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("drops the old fire-and-forget response when the transport closes", async () => {
    const daemon = await createDelayedDaemon();
    await daemon.client.respondToPermission(agentId, requests[0].id, { behavior: "allow" });
    await daemon.client.close();
    await vi.advanceTimersByTimeAsync(200);

    expect(daemon.delivered).toEqual([]);
    expect(daemon.pending).toEqual(requests);
  });

  describe.each(["allow", "deny"] as const)("permit %s", (action) => {
    it("keeps the transport open until the delayed response is resolved", async () => {
      const daemon = await createDelayedDaemon();
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const command = createPermitCommand().parseAsync(
        [action, agentId.slice(0, 7), "permission-w", "--json"],
        { from: "user" },
      );

      await vi.advanceTimersByTimeAsync(99);
      expect(daemon.isClosed()).toBe(false);
      expect(stdout).not.toHaveBeenCalled();
      expect(daemon.delivered).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      await command;
      expect(daemon.isClosed()).toBe(true);
      expect(daemon.pending).toEqual([requests[1]]);
      expect(JSON.parse(stdout.mock.calls.map(([output]) => output).join(""))).toEqual([
        {
          requestId: "permission-write",
          agentId,
          agentShortId: "2d85f42",
          name: "Write",
          result: action === "allow" ? "allowed" : "denied",
        },
      ]);
    });

    it("waits for every acknowledgement with --all", async () => {
      const daemon = await createDelayedDaemon();
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const command = createPermitCommand().parseAsync([action, agentId, "--all", "--json"], {
        from: "user",
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(daemon.isClosed()).toBe(false);
      expect(stdout).not.toHaveBeenCalled();
      expect(daemon.pending).toEqual([requests[1]]);

      await vi.advanceTimersByTimeAsync(100);
      await command;
      expect(daemon.isClosed()).toBe(true);
      expect(daemon.pending).toEqual([]);
      expect(daemon.delivered.map((message) => message.requestId)).toEqual([
        "permission-write",
        "permission-edit",
      ]);
      expect(JSON.parse(stdout.mock.calls.map(([output]) => output).join(""))).toHaveLength(2);
    });

    it("exits non-zero with an unconfirmed response when acknowledgement is missing", async () => {
      const daemon = await createDelayedDaemon(false);
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("CLI exited");
      });
      const command = createPermitCommand().parseAsync(
        [action, agentId, "permission-write", "--json"],
        { from: "user" },
      );
      const failure = expect(command).rejects.toThrow("CLI exited");

      await vi.advanceTimersByTimeAsync(14_999);
      expect(exit).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
      expect(daemon.isClosed()).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await failure;
      expect(exit).toHaveBeenCalledWith(1);
      expect(stdout).not.toHaveBeenCalled();
      expect(daemon.isClosed()).toBe(true);
      expect(JSON.parse(stderr.mock.calls.map(([output]) => output).join(""))).toEqual({
        error: {
          code: "PERMISSION_RESPONSE_UNCONFIRMED",
          message:
            "Permission response unconfirmed for request permission-write: Timeout waiting for message (15000ms)",
          details: 'Use "paseo permit ls" to check whether the request is still pending',
        },
      });
    });
  });
});
