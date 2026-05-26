import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export type GitInfo = {
  branchName: string
  commitSha: string
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
