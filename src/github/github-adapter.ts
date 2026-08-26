import { Octokit } from "@octokit/rest";
// Leaf constants module (no imports of its own), so this does not create a
// cycle with analysis/ → github/.
import { AGENT_READY_LABEL } from "../analysis/label-reconciliation.js";
import type { ProcessRunner } from "../platform/process-runner.js";
import {
  resolveRepositoryContext,
  safeProcessEnv,
} from "./repository-context.js";

export class GitHubError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GitHubError";
  }
}

export interface GitHubIssue {
  /** Numeric database id, distinct from `number`. Required by the sub-issues API. */
  id: number;
  number: number;
  nodeId: string;
  title: string;
  body: string;
  updatedAt: string;
  state: string;
  htmlUrl: string;
}

export interface PullRequestRef {
  number: number;
  url: string;
  head: string;
  state: string;
}

export interface IssueCommentRef {
  id: number;
  body: string;
}

export interface CreatePullRequestInput {
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
}

/**
 * GitHub operations required by the workflow. Implementations must never
 * leak credentials and must be idempotent-friendly (lookup before create).
 */
export interface GitHubPort {
  getIssue(number: number): Promise<GitHubIssue>;
  /** Find an issue by exact normalized title, or null when none exists. */
  findIssueByTitle(title: string): Promise<GitHubIssue | null>;
  updateIssueBody(number: number, body: string): Promise<GitHubIssue>;
  createIssueComment(number: number, body: string): Promise<void>;
  findPullRequestByHead(head: string): Promise<PullRequestRef | null>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRef>;
  /** Find a comment whose body contains the given marker, or null. */
  findIssueCommentByMarker(
    issueNumber: number,
    marker: string,
  ): Promise<IssueCommentRef | null>;
  createIssue(input: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<GitHubIssue>;
  ensureLabel(name: string, color: string): Promise<void>;
  listLabels(number: number): Promise<string[]>;
  addLabel(number: number, name: string): Promise<void>;
  /** Link an existing issue as a GitHub sub-issue of a parent issue. */
  addSubIssue(parentNumber: number, subIssueId: number): Promise<void>;
  /** Titles of every open issue labeled "epic", for reuse-by-title prompting. */
  listOpenEpicTitles(): Promise<string[]>;
  /** Open non-epic issues with extracted requirement codes for reuse prompting. */
  listOpenLeafIssues(): Promise<Array<{ number: number; title: string; requirementCodes: string[] }>>;
  removeLabel(number: number, name: string): Promise<void>;
  closeIssue(number: number): Promise<void>;
}

/** Minimal structural surface of Octokit used by the adapter. */
export interface OctokitIssueData {
  id: number;
  number: number;
  node_id: string;
  title: string;
  body?: string | null;
  updated_at: string;
  state: string;
  html_url: string;
  pull_request?: unknown;
  labels?: Array<string | { name?: string }>;
}

export interface OctokitCommentData {
  id: number;
  body?: string | null;
}

export interface OctokitPullData {
  number: number;
  html_url: string;
  state: string;
  head: { ref: string };
}

export interface OctokitLike {
  rest: {
    issues: {
      get(params: {
        owner: string;
        repo: string;
        issue_number: number;
      }): Promise<{ data: OctokitIssueData }>;
      update(params: {
        owner: string;
        repo: string;
        issue_number: number;
        body?: string | null;
        state?: "open" | "closed";
      }): Promise<{ data: OctokitIssueData }>;
      listForRepo(params: {
        owner: string;
        repo: string;
        state: "open" | "closed" | "all";
        labels?: string;
        per_page: number;
        page: number;
      }): Promise<{ data: OctokitIssueData[] }>;
      listComments(params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page: number;
        page: number;
      }): Promise<{ data: OctokitCommentData[] }>;
      createComment(params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<{ data: OctokitCommentData }>;
      create(params: {
        owner: string;
        repo: string;
        title: string;
        body: string;
        labels: string[];
      }): Promise<{ data: OctokitIssueData }>;
      getLabel(params: {
        owner: string;
        repo: string;
        name: string;
      }): Promise<{ data: unknown }>;
      createLabel(params: {
        owner: string;
        repo: string;
        name: string;
        color: string;
      }): Promise<{ data: unknown }>;
      listLabelsOnIssue(params: {
        owner: string;
        repo: string;
        issue_number: number;
      }): Promise<{ data: Array<{ name?: string } | string> }>;
      addLabels(params: {
        owner: string;
        repo: string;
        issue_number: number;
        labels: string[];
      }): Promise<{ data: unknown }>;
      removeLabel(params: {
        owner: string;
        repo: string;
        issue_number: number;
        name: string;
      }): Promise<{ data: unknown }>;
      addSubIssue(params: {
        owner: string;
        repo: string;
        issue_number: number;
        sub_issue_id: number;
      }): Promise<{ data: unknown }>;
    };
    pulls: {
      list(params: {
        owner: string;
        repo: string;
        state: "open" | "closed" | "all";
        head: string;
        per_page: number;
        page: number;
      }): Promise<{ data: OctokitPullData[] }>;
      create(params: {
        owner: string;
        repo: string;
        title: string;
        body: string;
        head: string;
        base: string;
        draft: boolean;
      }): Promise<{ data: OctokitPullData }>;
    };
  };
}

export interface GitHubAdapterOptions {
  /** Inject an Octokit-shaped client (tests); default is a real Octokit. */
  octokit?: OctokitLike;
  /** Inject the token (tests); default resolves it via `gh auth token`. */
  token?: string;
}

const PAGE_SIZE = 100;

function mapIssue(data: OctokitIssueData): GitHubIssue {
  return {
    id: data.id,
    number: data.number,
    nodeId: data.node_id,
    title: data.title,
    body: data.body ?? "",
    updatedAt: data.updated_at,
    state: data.state,
    htmlUrl: data.html_url,
  };
}

function mapPull(data: OctokitPullData): PullRequestRef {
  return {
    number: data.number,
    url: data.html_url,
    head: data.head.ref,
    state: data.state,
  };
}

function normalizeIssueTitle(title: string): string {
  return title.trim().toLowerCase();
}

/**
 * Authenticated GitHub adapter bound to the repository resolved from the
 * local clone. The token is obtained from `gh auth token`, held only in
 * memory, and never logged or persisted.
 */
export class GitHubAdapter implements GitHubPort {
  private constructor(
    private readonly owner: string,
    private readonly repo: string,
    private readonly octokit: OctokitLike,
  ) {}

  static async create(
    root: string,
    processRunner: ProcessRunner,
    options: GitHubAdapterOptions = {},
  ): Promise<GitHubAdapter> {
    const ctx = await resolveRepositoryContext(root, processRunner);

    let octokit: OctokitLike;
    if (options.octokit !== undefined) {
      octokit = options.octokit;
    } else {
      const token =
        options.token ??
        (await resolveGhToken(ctx.root, processRunner));
      octokit = new Octokit({
        auth: token,
        // Pin the REST API version: GitHub deprecated the unversioned API and
        // returns a deprecation warning (and, from 2028, will reject it).
        // Kept in sync with the latest version GitHub publishes; verify no
        // breaking changes affect our usage before bumping further.
        request: {
          headers: { "X-GitHub-Api-Version": "2026-03-10" },
        },
      });
    }

    return new GitHubAdapter(ctx.repository.owner, ctx.repository.repo, octokit);
  }

  async getIssue(number: number): Promise<GitHubIssue> {
    try {
      const { data } = await this.octokit.rest.issues.get({
        owner: this.owner,
        repo: this.repo,
        issue_number: number,
      });
      return mapIssue(data);
    } catch (error) {
      throw new GitHubError(`failed to fetch issue #${number}`, { cause: error });
    }
  }

  async findIssueByTitle(title: string): Promise<GitHubIssue | null> {
    const desired = normalizeIssueTitle(title);
    try {
      let page = 1;
      let closedMatch: OctokitIssueData | undefined;
      for (;;) {
        const { data } = await this.octokit.rest.issues.listForRepo({
          owner: this.owner,
          repo: this.repo,
          state: "all",
          per_page: PAGE_SIZE,
          page,
        });
        const matches = data.filter(
          (issue) =>
            issue.pull_request === undefined &&
            normalizeIssueTitle(issue.title) === desired,
        );
        // Prefer an open issue: a closed issue with the same title is more
        // likely a resolved duplicate than the canonical one callers should
        // reuse (e.g. bootstrap epics deduplicated across separate plans).
        const openMatch = matches.find((issue) => issue.state === "open");
        if (openMatch !== undefined) return mapIssue(openMatch);
        closedMatch ??= matches[0];
        if (data.length < PAGE_SIZE) return closedMatch !== undefined ? mapIssue(closedMatch) : null;
        page += 1;
      }
    } catch (error) {
      throw new GitHubError(`failed to find issue titled ${JSON.stringify(title)}`, {
        cause: error,
      });
    }
  }

  async updateIssueBody(number: number, body: string): Promise<GitHubIssue> {
    try {
      const { data } = await this.octokit.rest.issues.update({
        owner: this.owner,
        repo: this.repo,
        issue_number: number,
        body,
      });
      return mapIssue(data);
    } catch (error) {
      throw new GitHubError(`failed to update issue #${number}`, {
        cause: error,
      });
    }
  }

  /**
   * Closes an issue by state. Only uses the update endpoint to avoid side effects
   * from other issue fields.
   */
  async closeIssue(number: number): Promise<void> {
    try {
      await this.octokit.rest.issues.update({
        owner: this.owner,
        repo: this.repo,
        issue_number: number,
        state: "closed",
      });
    } catch (error) {
      throw new GitHubError(`failed to close issue #${number}`, {
        cause: error,
      });
    }
  }

  async createIssueComment(number: number, body: string): Promise<void> {
    try {
      await this.octokit.rest.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: number,
        body,
      });
    } catch (error) {
      throw new GitHubError(`failed to comment on issue #${number}`, {
        cause: error,
      });
    }
  }

  async findPullRequestByHead(head: string): Promise<PullRequestRef | null> {
    try {
      const pages = await this.paginate((page) =>
        this.octokit.rest.pulls.list({
          owner: this.owner,
          repo: this.repo,
          state: "open",
          head,
          per_page: PAGE_SIZE,
          page,
        }),
      );
      const match = pages.find((pull) => pull.head.ref === head);
      return match === undefined ? null : mapPull(match);
    } catch (error) {
      throw new GitHubError(`failed to find pull request for head ${head}`, {
        cause: error,
      });
    }
  }

  async createPullRequest(
    input: CreatePullRequestInput,
  ): Promise<PullRequestRef> {
    try {
      const { data } = await this.octokit.rest.pulls.create({
        owner: this.owner,
        repo: this.repo,
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: input.draft ?? false,
      });
      return mapPull(data);
    } catch (error) {
      throw new GitHubError(
        `failed to create pull request for head ${input.head}`,
        { cause: error },
      );
    }
  }

  async findIssueCommentByMarker(
    issueNumber: number,
    marker: string,
  ): Promise<IssueCommentRef | null> {
    try {
      const pages = await this.paginate((page) =>
        this.octokit.rest.issues.listComments({
          owner: this.owner,
          repo: this.repo,
          issue_number: issueNumber,
          per_page: PAGE_SIZE,
          page,
        }),
      );
      const match = pages.find((comment) => comment.body?.includes(marker));
      if (match === undefined) return null;
      return { id: match.id, body: match.body ?? "" };
    } catch (error) {
      throw new GitHubError(
        `failed to list comments on issue #${issueNumber}`,
        { cause: error },
      );
    }
  }

  async createIssue(input: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<GitHubIssue> {
    try {
      const { data } = await this.octokit.rest.issues.create({
        owner: this.owner,
        repo: this.repo,
        title: input.title,
        body: input.body,
        labels: input.labels,
      });
      return mapIssue(data);
    } catch (error) {
      throw new GitHubError("failed to create issue", { cause: error });
    }
  }

  async ensureLabel(name: string, color: string): Promise<void> {
    try {
      await this.octokit.rest.issues.getLabel({
        owner: this.owner,
        repo: this.repo,
        name,
      });
    } catch {
      try {
        await this.octokit.rest.issues.createLabel({
          owner: this.owner,
          repo: this.repo,
          name,
          color,
        });
      } catch {
        // Already exists from a concurrent call
      }
    }
  }

  async listLabels(number: number): Promise<string[]> {
    try {
      const { data } = await this.octokit.rest.issues.listLabelsOnIssue({
        owner: this.owner,
        repo: this.repo,
        issue_number: number,
      });
      return data.map((l) => (typeof l === "string" ? l : (l.name ?? "")));
    } catch (error) {
      throw new GitHubError(`failed to list labels for issue #${number}`, { cause: error });
    }
  }

  /**
   * Adds a label. `agent:ready` is guarded at this chokepoint: it advertises
   * an issue as available work, so it must never land on closed work no
   * matter which caller asks. The state check runs only for that label, so
   * ordinary label writes cost no extra API call.
   */
  async addLabel(number: number, name: string): Promise<void> {
    if (name === AGENT_READY_LABEL) {
      const issue = await this.getIssue(number);
      if (issue.state.toLowerCase() === "closed") {
        throw new GitHubError(
          `refusing to add "${name}" to issue #${number}: the issue is closed`,
        );
      }
    }

    try {
      await this.octokit.rest.issues.addLabels({
        owner: this.owner,
        repo: this.repo,
        issue_number: number,
        labels: [name],
      });
    } catch (error) {
      throw new GitHubError(`failed to add label "${name}" to issue #${number}`, { cause: error });
    }
  }

  async removeLabel(number: number, name: string): Promise<void> {
    try {
      await this.octokit.rest.issues.removeLabel({
        owner: this.owner,
        repo: this.repo,
        issue_number: number,
        name,
      });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404) return;
      throw new GitHubError(`failed to remove label "${name}" from issue #${number}`, { cause: error });
    }
  }

  async addSubIssue(parentNumber: number, subIssueId: number): Promise<void> {
    try {
      await this.octokit.rest.issues.addSubIssue({
        owner: this.owner,
        repo: this.repo,
        issue_number: parentNumber,
        sub_issue_id: subIssueId,
      });
    } catch (error) {
      throw new GitHubError(
        `failed to add sub-issue ${subIssueId} to #${parentNumber}`,
        { cause: error },
      );
    }
  }

  async listOpenEpicTitles(): Promise<string[]> {
    try {
      const pages = await this.paginate((page) =>
        this.octokit.rest.issues.listForRepo({
          owner: this.owner,
          repo: this.repo,
          state: "open",
          labels: "epic",
          per_page: PAGE_SIZE,
          page,
        }),
      );
      return pages
        .filter((issue) => issue.pull_request === undefined)
        .map((issue) => issue.title);
    } catch (error) {
      throw new GitHubError("failed to list open epic titles", { cause: error });
    }
  }

  async listOpenLeafIssues(): Promise<Array<{ number: number; title: string; requirementCodes: string[] }>> {
    try {
      const pages = await this.paginate((page) =>
        this.octokit.rest.issues.listForRepo({
          owner: this.owner,
          repo: this.repo,
          state: "open",
          per_page: PAGE_SIZE,
          page,
        }),
      );
      return pages
        .filter((issue) => issue.pull_request === undefined)
        .filter((issue) => !(issue.labels ?? []).some((label) => (typeof label === "string" ? label : label.name) === "epic"))
        .map((issue) => ({
          number: issue.number,
          title: issue.title,
          requirementCodes: Array.from(new Set(`${issue.title}\n${issue.body ?? ""}`.match(/\b(?:RF-[A-Z0-9-]+|CRUE-\d+|RNF-[A-Z0-9-]+)\b/g) ?? [])).sort(),
        }));
    } catch (error) {
      throw new GitHubError("failed to list open leaf issues", { cause: error });
    }
  }

  /** Fetch every page until one returns fewer than a full page. */
  private async paginate<T>(
    fetchPage: (page: number) => Promise<{ data: T[] }>,
  ): Promise<T[]> {
    const all: T[] = [];
    let page = 1;
    for (;;) {
      const { data } = await fetchPage(page);
      all.push(...data);
      if (data.length < PAGE_SIZE) return all;
      page += 1;
    }
  }
}

async function resolveGhToken(
  cwd: string,
  processRunner: ProcessRunner,
): Promise<string> {
  const result = await processRunner.run({
    command: "gh",
    args: ["auth", "token"],
    cwd,
    timeoutMs: 30_000,
    env: safeProcessEnv(),
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || "run `gh auth login`";
    throw new GitHubError(`gh is not authenticated: ${detail}`);
  }
  const token = result.stdout.trim();
  if (token.length === 0) {
    throw new GitHubError("gh auth token returned an empty token");
  }
  return token;
}
