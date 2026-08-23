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

interface AddItemResult {
  addProjectV2ItemById: {
    item: { id: string };
  };
}

interface ProjectFieldsResult {
  node: {
    fields: {
      nodes: Array<{
        __typename: string;
        id: string;
        name: string;
        options?: Array<{ id: string; name: string }>;
      }>;
    };
  };
}

interface UpdateFieldResult {
  updateProjectV2ItemFieldValue: { projectV2Item: { id: string } };
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
    status: string,
  ): Promise<void> {
    try {
      const graphql = this.octokit.graphql as GraphQLFunction;

      // Step 1: add the item to the project.
      const addMutation = `mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
          item { id }
        }
      }`;
      const added = await graphql<AddItemResult>(addMutation, {
        projectId: boardId,
        contentId: issueNodeId,
      });
      const itemId = added.addProjectV2ItemById.item.id;

      // Step 2: find the Status field and the matching option ID.
      const fieldsQuery = `query($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            fields(first: 20) {
              nodes {
                __typename
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options { id name }
                }
              }
            }
          }
        }
      }`;
      const fieldsData = await graphql<ProjectFieldsResult>(fieldsQuery, {
        projectId: boardId,
      });
      const statusField = fieldsData.node.fields.nodes.find(
        (f) => f.__typename === "ProjectV2SingleSelectField" && f.name === "Status",
      );
      if (statusField === undefined || statusField.options === undefined) {
        // No Status field on this board — item was added, just skip status set.
        return;
      }
      const option = statusField.options.find(
        (o) => o.name.toLowerCase() === status.toLowerCase(),
      );
      if (option === undefined) {
        // Requested status not found — item was added, skip status set.
        return;
      }

      // Step 3: set the Status field value.
      const updateMutation = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: { singleSelectOptionId: $optionId }
        }) {
          projectV2Item { id }
        }
      }`;
      await graphql<UpdateFieldResult>(updateMutation, {
        projectId: boardId,
        itemId,
        fieldId: statusField.id,
        optionId: option.id,
      });
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
