import { createHash } from "node:crypto";

import { normalizePublicGitHubRepository, validateGitBranch } from "@codebase-explainer/repository";
import type { GitHubWebhookJobData } from "@codebase-explainer/shared";
import { Webhooks } from "@octokit/webhooks";
import { z } from "zod";

import { getGitHubWebhookConfiguration } from "../config/env.js";
import {
  GitHubWebhookQueueError,
  getDefaultGitHubWebhookQueue,
  type GitHubWebhookEnqueueStatus,
  type GitHubWebhookQueueContract,
} from "../queues/github-webhook.queue.js";

const eventNamePattern = /^[a-z][a-z_]{0,49}$/u;
const deliveryIdPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/u;
const signaturePattern = /^sha256=[0-9a-f]{64}$/u;
const commitPattern = /^[0-9a-f]{40,64}$/u;
const deletedCommitPattern = /^0{40,64}$/u;

const repositorySchema = z.object({
  id: z.number().int().positive().safe(),
  name: z.string().trim().min(1).max(100),
  full_name: z.string().trim().min(3).max(140),
  private: z.boolean(),
  default_branch: z.string().trim().min(1).max(255),
  owner: z.object({ login: z.string().trim().min(1).max(39) }),
});
const installationSchema = z.object({
  id: z.number().int().positive().safe(),
});
const pushSchema = z.object({
  ref: z.string().trim().min(1).max(300),
  after: z.string().regex(commitPattern),
  deleted: z.boolean().optional().default(false),
  repository: repositorySchema,
  installation: installationSchema,
});
const installationEventSchema = z.object({
  action: z.string().trim().min(1).max(100),
  installation: installationSchema,
});
const installationRepositoriesSchema = z.object({
  action: z.string().trim().min(1).max(100),
  installation: installationSchema,
  repositories_removed: z
    .array(z.object({ id: z.number().int().positive().safe() }))
    .max(1_000)
    .optional()
    .default([]),
});

export type GitHubWebhookReceipt = {
  accepted: true;
  deliveryId: string;
  eventName: string;
  status: GitHubWebhookEnqueueStatus | "ignored";
  jobId?: string;
};

export type ReceiveGitHubWebhookInput = {
  deliveryId: string;
  eventName: string;
  signature: string;
  rawBody: Buffer;
};

export class GitHubWebhookError extends Error {
  override readonly name = "GitHubWebhookError";

  constructor(
    readonly code:
      | "INVALID_WEBHOOK_HEADERS"
      | "INVALID_WEBHOOK_SIGNATURE"
      | "INVALID_WEBHOOK_PAYLOAD"
      | "DELIVERY_CONFLICT"
      | "WEBHOOK_QUEUE_UNAVAILABLE",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface GitHubWebhookServiceContract {
  receive(input: ReceiveGitHubWebhookInput): Promise<GitHubWebhookReceipt>;
}

export class GitHubWebhookService implements GitHubWebhookServiceContract {
  private readonly webhooks: Webhooks;

  constructor(
    secret: string,
    private readonly queue: GitHubWebhookQueueContract,
    private readonly enqueueTimeoutMs = 5_000,
  ) {
    if (secret.length < 32) {
      throw new Error("GitHub webhook secret must contain at least 32 characters");
    }
    if (!Number.isSafeInteger(enqueueTimeoutMs) || enqueueTimeoutMs <= 0) {
      throw new Error("GitHub webhook enqueue timeout must be positive");
    }
    this.webhooks = new Webhooks({ secret });
  }

  async receive(input: ReceiveGitHubWebhookInput): Promise<GitHubWebhookReceipt> {
    this.validateHeaders(input);
    let payloadText: string;
    try {
      payloadText = new TextDecoder("utf-8", { fatal: true }).decode(input.rawBody);
    } catch (cause) {
      throw new GitHubWebhookError(
        "INVALID_WEBHOOK_PAYLOAD",
        "The GitHub webhook payload must be valid UTF-8",
        { cause },
      );
    }

    let verified = false;
    try {
      verified = await this.webhooks.verify(payloadText, input.signature);
    } catch {
      verified = false;
    }
    if (!verified) {
      throw new GitHubWebhookError(
        "INVALID_WEBHOOK_SIGNATURE",
        "The GitHub webhook signature is invalid",
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(payloadText) as unknown;
    } catch (cause) {
      throw new GitHubWebhookError(
        "INVALID_WEBHOOK_PAYLOAD",
        "The GitHub webhook payload is invalid",
        { cause },
      );
    }

    const payloadSha256 = createHash("sha256")
      .update(input.rawBody)
      .digest("hex");
    const job = this.createJob({
      eventName: input.eventName,
      deliveryId: input.deliveryId,
      payloadSha256,
      payload,
    });
    if (!job) {
      return {
        accepted: true,
        deliveryId: input.deliveryId,
        eventName: input.eventName,
        status: "ignored",
      };
    }

    try {
      const result = await this.enqueueWithinDeadline(job);
      return {
        accepted: true,
        deliveryId: input.deliveryId,
        eventName: input.eventName,
        status: result.status,
        jobId: result.jobId,
      };
    } catch (cause) {
      if (cause instanceof GitHubWebhookQueueError) {
        throw new GitHubWebhookError(
          cause.code === "DELIVERY_CONFLICT"
            ? "DELIVERY_CONFLICT"
            : "WEBHOOK_QUEUE_UNAVAILABLE",
          cause.message,
          { cause },
        );
      }
      throw cause;
    }
  }

  private async enqueueWithinDeadline(
    job: GitHubWebhookJobData,
  ): Promise<Awaited<ReturnType<GitHubWebhookQueueContract["enqueue"]>>> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.queue.enqueue(job),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(
              new GitHubWebhookQueueError(
                "QUEUE_UNAVAILABLE",
                "The GitHub webhook queue did not respond in time",
              ),
            );
          }, this.enqueueTimeoutMs);
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private validateHeaders(input: ReceiveGitHubWebhookInput): void {
    if (
      !deliveryIdPattern.test(input.deliveryId) ||
      !eventNamePattern.test(input.eventName) ||
      !signaturePattern.test(input.signature) ||
      input.rawBody.length === 0
    ) {
      throw new GitHubWebhookError(
        "INVALID_WEBHOOK_HEADERS",
        "Required GitHub webhook headers are invalid",
      );
    }
  }

  private createJob(input: {
    eventName: string;
    deliveryId: string;
    payloadSha256: string;
    payload: unknown;
  }): GitHubWebhookJobData | undefined {
    const base = {
      deliveryId: input.deliveryId,
      payloadSha256: input.payloadSha256,
      receivedAt: new Date().toISOString(),
    };

    if (input.eventName === "push") {
      const parsed = pushSchema.safeParse(input.payload);
      if (!parsed.success) {
        throw new GitHubWebhookError(
          "INVALID_WEBHOOK_PAYLOAD",
          "The GitHub push payload is invalid",
        );
      }
      if (
        parsed.data.deleted ||
        deletedCommitPattern.test(parsed.data.after) ||
        !parsed.data.ref.startsWith("refs/heads/")
      ) {
        return undefined;
      }

      let branch: string;
      let defaultBranch: string;
      let normalized;
      try {
        branch = validateGitBranch(parsed.data.ref.slice("refs/heads/".length));
        defaultBranch = validateGitBranch(parsed.data.repository.default_branch);
        normalized = normalizePublicGitHubRepository(
          `https://github.com/${parsed.data.repository.owner.login}/${parsed.data.repository.name}`,
        );
      } catch (cause) {
        throw new GitHubWebhookError(
          "INVALID_WEBHOOK_PAYLOAD",
          "The GitHub push repository metadata is invalid",
          { cause },
        );
      }
      if (
        normalized.fullName.toLowerCase() !==
        parsed.data.repository.full_name.toLowerCase()
      ) {
        throw new GitHubWebhookError(
          "INVALID_WEBHOOK_PAYLOAD",
          "The GitHub push repository identity is inconsistent",
        );
      }

      return {
        ...base,
        kind: "push",
        installationId: parsed.data.installation.id,
        githubRepositoryId: parsed.data.repository.id,
        owner: normalized.owner,
        repository: normalized.name,
        fullName: normalized.fullName,
        repositoryUrl: normalized.htmlUrl,
        private: parsed.data.repository.private,
        defaultBranch,
        branch,
        commitSha: parsed.data.after,
      };
    }

    if (input.eventName === "installation") {
      const parsed = installationEventSchema.safeParse(input.payload);
      if (!parsed.success) {
        throw new GitHubWebhookError(
          "INVALID_WEBHOOK_PAYLOAD",
          "The GitHub installation payload is invalid",
        );
      }
      if (parsed.data.action !== "deleted" && parsed.data.action !== "suspend") {
        return undefined;
      }
      return {
        ...base,
        kind: "installation_revoked",
        installationId: parsed.data.installation.id,
      };
    }

    if (input.eventName === "installation_repositories") {
      const parsed = installationRepositoriesSchema.safeParse(input.payload);
      if (!parsed.success) {
        throw new GitHubWebhookError(
          "INVALID_WEBHOOK_PAYLOAD",
          "The GitHub installation repository payload is invalid",
        );
      }
      if (
        parsed.data.action !== "removed" ||
        parsed.data.repositories_removed.length === 0
      ) {
        return undefined;
      }
      return {
        ...base,
        kind: "repositories_revoked",
        installationId: parsed.data.installation.id,
        githubRepositoryIds: [
          ...new Set(parsed.data.repositories_removed.map((repository) => repository.id)),
        ],
      };
    }

    return undefined;
  }
}

let defaultService: GitHubWebhookService | undefined;

export function getDefaultGitHubWebhookService(): GitHubWebhookService {
  if (defaultService) {
    return defaultService;
  }
  const configuration = getGitHubWebhookConfiguration();
  if (!configuration) {
    throw new Error("GitHub webhooks are not configured");
  }
  defaultService = new GitHubWebhookService(
    configuration.secret,
    getDefaultGitHubWebhookQueue(),
    configuration.enqueueTimeoutMs,
  );
  return defaultService;
}
