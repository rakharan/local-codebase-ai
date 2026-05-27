import path from "node:path"
import fs from "node:fs/promises"
import fg from "fast-glob"
import ignore from "ignore"

const MAX_FILE_BYTES = 1_000_000

const defaultIgnoredPatterns = [
  "node_modules",
  "vendor",
  "third_party",
  "3rdparty",
  "dist",
  "build",
  "coverage",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".vercel",
  ".cache",
  ".codex",
  ".opencode",
  ".git",
  "logs",
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa",
  "*.dump",
  "*.sql.gz",
  "*.sqlite",
  "*.sqlite3",
  "*.db",
  "*.zip",
  "*.tar",
  "*.tgz",
  "*.gz",
  "*.7z",
  "*.rar",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.webp",
  "*.ico",
  "*.pdf",
  "*.woff",
  "*.woff2",
  "*.ttf",
  "*.eot",
  "*.class",
  "*.jar",
  "*.o",
  "*.obj",
  "*.so",
  "*.dll",
  "*.exe",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "composer.lock",
  "go.sum",
]

const allowedExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".sql",
  ".md",
  ".yml",
  ".yaml",
  ".php",
  ".phtml",
  ".inc",
  ".go",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".proto",
  ".toml",
  ".ini",
  ".conf",
  ".cfg",
  ".properties",
  ".xml",
  ".gradle",
  ".make",
  ".mk",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
])

const allowedBasenames = new Set([
  "dockerfile",
  "jenkinsfile",
  "makefile",
  "gnumakefile",
  "go.mod",
  "composer.json",
  "phpunit.xml",
  "phpunit.xml.dist",
])

export type SourceFile = {
  absolutePath: string
  relativePath: string
  content: string
}

export type ReadRepoFilesOptions = {
  include?: string[]
  exclude?: string[]
}

function isAllowedFile(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  const base = path.basename(lower)

  if (allowedBasenames.has(base)) return true
  if (lower.endsWith(".env.example")) return true

  const ext = path.extname(lower)

  return allowedExtensions.has(ext)
}

function isLikelyBinary(content: Buffer): boolean {
  if (content.includes(0)) return true

  const sample = content.subarray(0, Math.min(content.length, 8_000))
  let suspicious = 0

  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) continue
    if (byte >= 32) continue

    suspicious++
  }

  return sample.length > 0 && suspicious / sample.length > 0.05
}

async function buildIgnore(repoPath: string) {
  const ignored = ignore().add(defaultIgnoredPatterns)
  const gitignorePath = path.join(repoPath, ".gitignore")

  try {
    const gitignore = await fs.readFile(gitignorePath, "utf8")
    ignored.add(gitignore)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error
    }
  }

  return ignored
}

function normalizeGlobPattern(pattern: string): string {
  return pattern.replaceAll("\\", "/").replace(/^\/+/, "")
}

export async function readRepoFiles(repoPath: string, options: ReadRepoFilesOptions = {}): Promise<SourceFile[]> {
  const ignored = await buildIgnore(repoPath)
  const include = options.include?.length ? options.include.map(normalizeGlobPattern) : ["**/*"]
  const exclude = options.exclude?.map(normalizeGlobPattern) ?? []
  const entries = await fg(include, {
    cwd: repoPath,
    dot: true,
    onlyFiles: true,
    ignore: exclude,
  })

  const files: SourceFile[] = []

  for (const relativePath of entries) {
    if (ignored.ignores(relativePath)) continue
    if (!isAllowedFile(relativePath)) continue

    const absolutePath = path.join(repoPath, relativePath)
    const stat = await fs.stat(absolutePath)

    if (stat.size > MAX_FILE_BYTES) continue

    const buffer = await fs.readFile(absolutePath)

    if (isLikelyBinary(buffer)) continue

    const content = buffer.toString("utf8")

    if (!content.trim()) continue

    files.push({
      absolutePath,
      relativePath,
      content,
    })
  }

  return files
}
