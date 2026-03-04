import { execSync } from "child_process";
import path from "path";

export type GitProvider = "github" | "azuredevops";

/** Slugify a task title into a safe branch name segment */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Run a shell command in the given directory */
function run(cmd: string, cwd: string, timeout = 30000): string {
  return execSync(cmd, {
    cwd,
    encoding: "utf-8",
    timeout,
    maxBuffer: 1024 * 1024 * 10,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** Run a git command in the given directory */
function git(args: string, cwd: string, timeout = 30000): string {
  return run(`git ${args}`, cwd, timeout);
}

function sanitizeCliText(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/"/g, '\\"');
}

function sanitizeIssueId(issueId: string): string {
  const id = issueId.trim();
  if (!/^\d+$/.test(id)) {
    throw new Error(`Invalid issue id: ${issueId}`);
  }
  return id;
}

/**
 * Detect git provider from remote URL.
 * Returns "azuredevops" for Azure DevOps URLs, "github" otherwise.
 */
export function detectProvider(repoPath: string, override?: string): GitProvider {
  if (override === "github" || override === "azuredevops") return override;

  try {
    const remote = git("remote get-url origin", repoPath);
    if (
      remote.includes("dev.azure.com") ||
      remote.includes("visualstudio.com") ||
      remote.includes("azure.com")
    ) {
      return "azuredevops";
    }
  } catch {
    // No remote or git error
  }
  return "github";
}

export function getRemoteUrl(repoPath: string): string {
  return git("remote get-url origin", repoPath);
}

export interface WorktreeResult {
  worktreePath: string;
  branchName: string;
}

/**
 * Create a git worktree for a task.
 * Worktrees are placed at <repoPath>/.worktrees/<slug>-<id8>
 */
export function createWorktreeForTask(
  repoPath: string,
  taskId: string,
  taskTitle: string,
  baseBranch: string
): WorktreeResult {
  const dirName = `${slugify(taskTitle)}-${taskId.slice(0, 8)}`;
  const branchName = `task/${dirName}`;
  const worktreePath = path.join(repoPath, ".worktrees", dirName);

  // Fetch latest from remote (best-effort)
  try {
    git("fetch origin", repoPath, 15000);
  } catch {
    // Offline or no remote — continue with local state
  }

  // Determine the best starting point for the new branch
  // Prefer origin/<baseBranch>, fall back to local <baseBranch>
  let startPoint = `origin/${baseBranch}`;
  try {
    git(`rev-parse --verify "${startPoint}"`, repoPath);
  } catch {
    // origin/<baseBranch> doesn't exist — try local branch
    startPoint = baseBranch;
    try {
      git(`rev-parse --verify "${startPoint}"`, repoPath);
    } catch {
      // Local branch doesn't exist either — use HEAD
      startPoint = "HEAD";
    }
  }

  // Create worktree with a new branch based on the resolved start point
  git(
    `worktree add "${worktreePath}" -b "${branchName}" "${startPoint}"`,
    repoPath
  );

  return { worktreePath, branchName };
}

/**
 * Stage all changes, commit, and push the branch.
 */
export function commitAndPush(
  worktreePath: string,
  branchName: string,
  commitMessage: string
): void {
  // Check if there are any changes to commit
  const status = git("status --porcelain", worktreePath);
  if (!status) return; // Nothing to commit

  git("add -A", worktreePath);
  git(`commit -m "${commitMessage.replace(/"/g, '\\"')}"`, worktreePath);
  git(`push -u origin "${branchName}"`, worktreePath, 60000);
}

// ── PR operations (provider-specific) ──────────────────────────────

/**
 * Create a pull request. Returns the PR URL.
 */
export function createPullRequest(
  worktreePath: string,
  title: string,
  body: string,
  baseBranch: string,
  provider: GitProvider
): string {
  const safeTitle = title.replace(/"/g, '\\"');
  const safeBody = body.replace(/"/g, '\\"');

  if (provider === "azuredevops") {
    // az repos pr create auto-detects org/project/repo from git remote
    const output = run(
      `az repos pr create --title "${safeTitle}" --description "${safeBody}" --target-branch "${baseBranch}" --output json`,
      worktreePath,
      30000
    );
    try {
      const pr = JSON.parse(output);
      // Build the web URL from the response
      if (pr.url) {
        // API URL → web URL: replace _apis/git/repositories/.../pullRequests/N with _git/.../pullrequest/N
        const webUrl = pr.repository?.webUrl;
        if (webUrl && pr.pullRequestId) {
          return `${webUrl}/pullrequest/${pr.pullRequestId}`;
        }
      }
      // Fallback: return the API URL
      return pr.url || output;
    } catch {
      // If JSON parse fails, return raw output
      return output;
    }
  }

  // GitHub
  return run(
    `gh pr create --title "${safeTitle}" --body "${safeBody}" --base "${baseBranch}"`,
    worktreePath,
    30000
  );
}

/**
 * Merge/complete a pull request.
 */
export function mergePullRequest(
  prUrl: string,
  repoPath: string,
  provider: GitProvider
): void {
  if (provider === "azuredevops") {
    const prId = extractAzurePrId(prUrl);
    run(
      `az repos pr update --id ${prId} --status completed --output json`,
      repoPath,
      30000
    );
    // Delete branch after merge (best-effort)
    try {
      const prJson = run(
        `az repos pr show --id ${prId} --output json`,
        repoPath,
        15000
      );
      const pr = JSON.parse(prJson);
      // sourceRefName is like "refs/heads/task/..."
      const branchRef = pr.sourceRefName;
      if (branchRef) {
        const branchName = branchRef.replace("refs/heads/", "");
        git(`push origin --delete "${branchName}"`, repoPath, 15000);
      }
    } catch {
      // Branch cleanup is best-effort
    }
    return;
  }

  // GitHub
  run(`gh pr merge "${prUrl}" --merge --delete-branch`, repoPath, 30000);
}

/**
 * Close/abandon a pull request without merging.
 */
export function closePullRequest(
  prUrl: string,
  repoPath: string,
  provider: GitProvider
): void {
  if (provider === "azuredevops") {
    const prId = extractAzurePrId(prUrl);
    run(
      `az repos pr update --id ${prId} --status abandoned --output json`,
      repoPath,
      15000
    );
    // Delete remote branch (best-effort)
    try {
      const prJson = run(
        `az repos pr show --id ${prId} --output json`,
        repoPath,
        15000
      );
      const pr = JSON.parse(prJson);
      const branchRef = pr.sourceRefName;
      if (branchRef) {
        const branchName = branchRef.replace("refs/heads/", "");
        git(`push origin --delete "${branchName}"`, repoPath, 15000);
      }
    } catch {
      // Best-effort
    }
    return;
  }

  // GitHub
  run(`gh pr close "${prUrl}"`, repoPath, 15000);
  try {
    const branchInfo = run(
      `gh pr view "${prUrl}" --json headRefName --jq .headRefName`,
      repoPath,
      10000
    );
    if (branchInfo) {
      git(`push origin --delete "${branchInfo}"`, repoPath, 15000);
    }
  } catch {
    // Branch may already be deleted
  }
}

export interface RemoteIssue {
  id: string;
  title: string;
  body: string;
  url: string;
  state: string;
  tags: string;
}

export function listRemoteIssues(
  repoPath: string,
  provider: GitProvider,
  limit = 50
): RemoteIssue[] {
  if (provider === "azuredevops") {
    const wiql = sanitizeCliText(
      `Select [System.Id] From WorkItems Where [System.WorkItemType] = 'Issue' Order By [System.ChangedDate] DESC`
    );
    const queryOutput = run(
      `az boards query --wiql "${wiql}" --output json`,
      repoPath,
      30000
    );
    const query = JSON.parse(queryOutput) as { workItems?: Array<{ id: number }> };
    const ids = (query.workItems || []).slice(0, limit).map((w) => String(w.id));
    const issues: RemoteIssue[] = [];
    for (const id of ids) {
      const raw = run(
        `az boards work-item show --id ${sanitizeIssueId(id)} --output json`,
        repoPath,
        15000
      );
      const item = JSON.parse(raw) as {
        id?: number;
        fields?: Record<string, unknown>;
        _links?: { html?: { href?: string } };
        url?: string;
      };
      const fields = item.fields || {};
      issues.push({
        id: String(item.id ?? id),
        title: String(fields["System.Title"] || ""),
        body: String(fields["System.Description"] || ""),
        url: item._links?.html?.href || item.url || "",
        state: String(fields["System.State"] || "Active"),
        tags: String(fields["System.Tags"] || "").replace(/;/g, ", "),
      });
    }
    return issues;
  }

  const output = run(
    `gh issue list --state all --limit ${Math.max(1, Math.min(limit, 200))} --json number,title,body,url,state,labels`,
    repoPath,
    30000
  );
  const data = JSON.parse(output) as Array<{
    number: number;
    title: string;
    body?: string;
    url: string;
    state: string;
    labels?: Array<{ name?: string }>;
  }>;
  return data.map((issue) => ({
    id: String(issue.number),
    title: issue.title || "",
    body: issue.body || "",
    url: issue.url || "",
    state: issue.state || "OPEN",
    tags: (issue.labels || [])
      .map((l) => l.name || "")
      .filter(Boolean)
      .join(", "),
  }));
}

export function updateIssueState(
  repoPath: string,
  issueId: string,
  close: boolean,
  provider: GitProvider
): void {
  const id = sanitizeIssueId(issueId);
  if (provider === "azuredevops") {
    const state = close ? "Closed" : "Active";
    run(
      `az boards work-item update --id ${id} --fields "System.State=${state}" --output json`,
      repoPath,
      30000
    );
    return;
  }

  if (close) {
    run(`gh issue close ${id}`, repoPath, 30000);
  } else {
    run(`gh issue reopen ${id}`, repoPath, 30000);
  }
}

export function commentOnIssue(
  repoPath: string,
  issueId: string,
  body: string,
  provider: GitProvider
): void {
  const id = sanitizeIssueId(issueId);
  const safeBody = sanitizeCliText(body);
  if (provider === "azuredevops") {
    run(
      `az boards work-item update --id ${id} --discussion "${safeBody}" --output json`,
      repoPath,
      30000
    );
    return;
  }
  run(`gh issue comment ${id} --body "${safeBody}"`, repoPath, 30000);
}

// ── Provider-agnostic operations ───────────────────────────────────

/**
 * Clean up a git worktree and its local branch.
 */
export function cleanupWorktree(
  repoPath: string,
  worktreePath: string,
  branchName?: string
): void {
  try {
    git(`worktree remove "${worktreePath}" --force`, repoPath);
  } catch {
    // Worktree may already be removed
  }

  if (branchName) {
    try {
      git(`branch -D "${branchName}"`, repoPath);
    } catch {
      // Branch may already be deleted
    }
  }
}

/**
 * Validate that a path is a valid git repository.
 * Also returns the detected provider.
 */
export function validateGitRepo(repoPath: string): {
  valid: boolean;
  remote?: string;
  currentBranch?: string;
  detectedProvider?: GitProvider;
  error?: string;
} {
  try {
    const topLevel = git("rev-parse --show-toplevel", repoPath);
    if (!topLevel) return { valid: false, error: "Not a git repository" };

    let remote = "";
    try {
      remote = git("remote get-url origin", repoPath);
    } catch {
      // No remote configured
    }

    const currentBranch = git("rev-parse --abbrev-ref HEAD", repoPath);
    const detectedProvider = detectProvider(repoPath);

    return { valid: true, remote, currentBranch, detectedProvider };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : "Not a git repository",
    };
  }
}

/**
 * Prune orphaned worktrees.
 */
export function cleanupOrphanedWorktrees(repoPath: string): void {
  try {
    git("worktree prune", repoPath);
  } catch {
    // Non-critical
  }
}

/**
 * Get the diff of a worktree against its base branch.
 */
export function getWorktreeDiff(
  worktreePath: string,
  baseBranch: string
): string {
  try {
    // Try origin/<baseBranch> first, fall back to local <baseBranch>
    let diffBase = `origin/${baseBranch}`;
    try {
      git(`rev-parse --verify "${diffBase}"`, worktreePath);
    } catch {
      diffBase = baseBranch;
    }
    const diff = git(
      `diff "${diffBase}"...HEAD`,
      worktreePath,
      15000
    );
    const uncommitted = git("diff HEAD", worktreePath, 15000);

    if (uncommitted && diff) {
      return diff + "\n" + uncommitted;
    }
    return diff || uncommitted || "";
  } catch {
    try {
      return git("diff HEAD", worktreePath, 15000);
    } catch {
      return "";
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Extract PR ID from an Azure DevOps PR URL.
 * URL format: https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}
 */
function extractAzurePrId(prUrl: string): string {
  const match = prUrl.match(/pullrequest\/(\d+)/i);
  if (match) return match[1];

  // Maybe it's already just a number
  const numMatch = prUrl.match(/^(\d+)$/);
  if (numMatch) return numMatch[1];

  throw new Error(`Could not extract PR ID from URL: ${prUrl}`);
}
