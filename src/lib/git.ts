import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export type GitInfo = {
  branchName: string
  commitSha: string
}

export type CommitInfo = {
  sha: string
  message: string
  author: string
  date: string
  files: string[]
}

async function git(repoPath: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
      windowsHide: true,
    })

    const value = stdout.trim()

    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

export async function getGitInfo(repoPath: string): Promise<GitInfo> {
  const branchName =
    (await git(repoPath, ["branch", "--show-current"])) ??
    (await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])) ??
    "unknown"
  const commitSha = (await git(repoPath, ["rev-parse", "HEAD"])) ?? "unknown"

  return {
    branchName,
    commitSha,
  }
}

export async function getCommits(
  repoPath: string,
  since?: string,
  until?: string,
): Promise<CommitInfo[]> {
  const format = "%H|%an|%ad|%s"
  const args = ["log", "--all", `--format=${format}`, "--date=short", "--name-only", "--reverse"]

  if (since) {
    args.push("--since", since)
  }

  if (until) {
    args.push("--until", until)
  }

  const output = await git(repoPath, args)

  if (!output) return []

  const commits: CommitInfo[] = []
  let current: CommitInfo | undefined

  for (const line of output.split("\n")) {
    const trimmed = line.trim()

    if (!trimmed) {
      if (current) {
        commits.push(current)
        current = undefined
      }
      continue
    }

    const parts = trimmed.split("|")

    if (parts.length >= 4 && /^[0-9a-f]{40}$/i.test(parts[0] ?? "")) {
      if (current) {
        commits.push(current)
      }

      current = {
        sha: parts[0] ?? "",
        author: parts[1] ?? "",
        date: parts[2] ?? "",
        message: parts.slice(3).join("|"),
        files: [],
      }
    } else if (current) {
      current.files.push(trimmed)
    }
  }

  if (current) {
    commits.push(current)
  }

  return commits
}
