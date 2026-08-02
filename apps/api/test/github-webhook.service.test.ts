import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  GitHubWebhookQueueError,
  type GitHubWebhookQueueContract,
} from "../src/queues/github-webhook.queue.js";
import {
  GitHubWebhookError,
  GitHubWebhookService,
} from "../src/services/github-webhook.service.js";

const secret = "a-secure-webhook-secret-with-at-least-32-characters";
const deliveryId = "72d3162e-cc78-11e3-81ab-4c9367dc0958";

function signature(payload: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

function createQueue(): GitHubWebhookQueueContract {
  return {
    enqueue: vi.fn().mockImplementation(async (data) => ({
      jobId: data.deliveryId,
      status: "queued" as const,
    })),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

const pushPayload = {
  ref: "refs/heads/main",
  after: "a".repeat(40),
  deleted: false,
  installation: { id: 501 },
  repository: {
    id: 9001,
    name: "private-repository",
    full_name: "owner/private-repository",
    private: true,
    default_branch: "main",
    owner: { login: "owner" },
  },
};

async function receive(
  service: GitHubWebhookService,
  eventName: string,
  payload: unknown,
) {
  const raw = JSON.stringify(payload);
  return service.receive({
    deliveryId,
    eventName,
    signature: signature(raw),
    rawBody: Buffer.from(raw),
  });
}

describe("GitHubWebhookService", () => {
  it("verifies and minimizes a branch push before queueing", async () => {
    const queue = createQueue();
    const service = new GitHubWebhookService(secret, queue);

    await expect(receive(service, "push", pushPayload)).resolves.toMatchObject({
      accepted: true,
      deliveryId,
      eventName: "push",
      status: "queued",
      jobId: deliveryId,
    });
    expect(queue.enqueue).toHaveBeenCalledWith({
      kind: "push",
      deliveryId,
      payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      receivedAt: expect.any(String),
      installationId: 501,
      githubRepositoryId: 9001,
      owner: "owner",
      repository: "private-repository",
      fullName: "owner/private-repository",
      repositoryUrl: "https://github.com/owner/private-repository",
      private: true,
      defaultBranch: "main",
      branch: "main",
      commitSha: "a".repeat(40),
    });
  });

  it("rejects an invalid signature before queue access", async () => {
    const queue = createQueue();
    const service = new GitHubWebhookService(secret, queue);
    const raw = JSON.stringify(pushPayload);

    await expect(
      service.receive({
        deliveryId,
        eventName: "push",
        signature: `sha256=${"0".repeat(64)}`,
        rawBody: Buffer.from(raw),
      }),
    ).rejects.toMatchObject({ code: "INVALID_WEBHOOK_SIGNATURE" });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("accepts but ignores tag pushes and branch deletions", async () => {
    const queue = createQueue();
    const service = new GitHubWebhookService(secret, queue);

    await expect(
      receive(service, "push", { ...pushPayload, ref: "refs/tags/v1.0.0" }),
    ).resolves.toMatchObject({ status: "ignored" });
    await expect(
      receive(service, "push", {
        ...pushPayload,
        deleted: true,
        after: "0".repeat(40),
      }),
    ).resolves.toMatchObject({ status: "ignored" });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("queues installation and repository access revocations", async () => {
    const queue = createQueue();
    const service = new GitHubWebhookService(secret, queue);

    await receive(service, "installation", {
      action: "suspend",
      installation: { id: 501 },
    });
    await receive(service, "installation_repositories", {
      action: "removed",
      installation: { id: 501 },
      repositories_removed: [{ id: 9001 }, { id: 9001 }, { id: 9002 }],
    });

    expect(queue.enqueue).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: "installation_revoked",
        installationId: 501,
      }),
    );
    expect(queue.enqueue).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: "repositories_revoked",
        installationId: 501,
        githubRepositoryIds: [9001, 9002],
      }),
    );
  });

  it("maps delivery conflicts without exposing queue internals", async () => {
    const queue = createQueue();
    vi.mocked(queue.enqueue).mockRejectedValue(
      new GitHubWebhookQueueError(
        "DELIVERY_CONFLICT",
        "GitHub delivery identifier was already used for another payload",
      ),
    );
    const service = new GitHubWebhookService(secret, queue);

    await expect(receive(service, "push", pushPayload)).rejects.toEqual(
      expect.objectContaining<Partial<GitHubWebhookError>>({
        code: "DELIVERY_CONFLICT",
      }),
    );
  });

  it("fails within the configured queue deadline", async () => {
    const queue = createQueue();
    vi.mocked(queue.enqueue).mockImplementation(() => new Promise(() => undefined));
    const service = new GitHubWebhookService(secret, queue, 10);

    await expect(receive(service, "push", pushPayload)).rejects.toMatchObject({
      code: "WEBHOOK_QUEUE_UNAVAILABLE",
      message: "The GitHub webhook queue did not respond in time",
    });
  });
});
