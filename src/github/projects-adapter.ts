import { Octokit } from "@octokit/rest";
import type { ProcessRunner } from "../platform/process-runner.js";
import {
  resolveRepositoryContext,
  safeProcessEnv,
} from "./repository-context.js";

export interface Board {
  id: string;
  title: string;
}

export interface ProjectsPort {
  listBoards(): Promise<Board[]>;
  createBoard(title: string, columns: string[]): Promise<Board>;
  addIssueToBoard(boardId: string, issueNodeId: string, status: string): Promise<void>;
}

export class ProjectsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProjectsError";
  }
}

type GraphQLFunction = <T = unknown>(query: string, variables?: Record<string, unknown>) => Promise<T>;

interface OwnerNodeData {
  id: string;
}

interface ProjectsListData {
  organization?: {
    projectsV2: {
      nodes: Board[];
    };
  };
  user?: {
    projectsV2: {
      nodes: Board[];
    };
  };
}

interface OwnerQueryResult {
  organization?: OwnerNodeData;
  user?: OwnerNodeData;
}

interface CreateProjectResult {
  createProjectV2: {
    projectV2: Board;
  };
}

/**
 * GitHub Projects v2 adapter bound to the repository resolved from the
 * local clone. Uses the GitHub GraphQL API via authenticated Octokit.
 */
export class ProjectsAdapter implements ProjectsPort {
  private constructor(
    private readonly owner: string,
    private readonly octokit: Octokit,
    private readonly ownerType: "user" | "organization",
  ) {}

  static async create(
    root: string,
    runner: ProcessRunner,
  ): Promise<ProjectsAdapter> {
    const ctx = await resolveRepositoryContext(root, runner);
    const token = await resolveGhToken(ctx.root, runner);
    
    const octokit = new Octokit({
      auth: token,
      request: { headers: { "X-GitHub-Api-Version": "2022-11-28" } },
    });

    // Determine owner type via REST; fall back to "user".
    let ownerType: "user" | "organization" = "user";
    try {
      await octokit.rest.orgs.get({ org: ctx.repository.owner });
      ownerType = "organization";
    } catch {
      // not an org, use user
    }

    return new ProjectsAdapter(ctx.repository.owner, octokit, ownerType);
  }

  async listBoards(): Promise<Board[]> {
    try {
      const query =
        this.ownerType === "organization"
          ? `query($login: String!) {
              organization(login: $login) {
                projectsV2(first: 20) {
                  nodes {
                    id
                    title
                  }
                }
              }
            }`
          : `query($login: String!) {
              user(login: $login) {
                projectsV2(first: 20) {
                  nodes {
                    id
                    title
                  }
                }
              }
            }`;

      const graphql = this.octokit.graphql as GraphQLFunction;
      const data = await graphql<ProjectsListData>(query, {
        login: this.owner,
      });

      const key = this.ownerType === "organization" ? "organization" : "user";
      return data[key]?.projectsV2?.nodes ?? [];
    } catch (error) {
      throw new ProjectsError(`failed to list boards for ${this.owner}`, {
        cause: error,
      });
    }
  }

  async createBoard(title: string, _columns: string[]): Promise<Board> {
    try {
      const graphql = this.octokit.graphql as GraphQLFunction;

      // Step 1: resolve owner node ID
      const ownerQuery =
        this.ownerType === "organization"
          ? `query($login: String!) {
              organization(login: $login) {
                id
              }
            }`
          : `query($login: String!) {
              user(login: $login) {
                id
              }
            }`;

      const ownerData = await graphql<OwnerQueryResult>(ownerQuery, {
        login: this.owner,
      });

      const ownerId = (ownerData.organization ?? ownerData.user)?.id;
      if (!ownerId) {
        throw new ProjectsError(`could not resolve node ID for ${this.owner}`);
      }

      // Step 2: create the project
      const createMutation = `mutation($ownerId: ID!, $title: String!) {
        createProjectV2(input: { ownerId: $ownerId, title: $title }) {
          projectV2 {
            id
            title
          }
        }
      }`;

      const created = await graphql<CreateProjectResult>(
        createMutation,
        { ownerId, title }
      );

      return created.createProjectV2.projectV2;
    } catch (error) {
      throw new ProjectsError(`failed to create board "${title}"`, {
        cause: error,
      });
    }
  }

  async addIssueToBoard(
    boardId: string,
    issueNodeId: string,
    _status: string,
  ): Promise<void> {
    try {
      const mutation = `mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
          item {
            id
          }
        }
      }`;

      const graphql = this.octokit.graphql as GraphQLFunction;
      await graphql(mutation, {
        projectId: boardId,
        contentId: issueNodeId,
      });

      // Status field update omitted in this milestone; field ID resolution requires
      // an extra query and the spec marks it as a future extension.
    } catch (error) {
      throw new ProjectsError(
        `failed to add issue to board ${boardId}`,
        { cause: error }
      );
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
    throw new ProjectsError(`gh is not authenticated: ${detail}`);
  }
  const token = result.stdout.trim();
  if (token.length === 0) {
    throw new ProjectsError("gh auth token returned an empty token");
  }
  return token;
}
