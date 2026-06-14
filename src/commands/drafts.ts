import { Command } from "commander"
import {
  listDrafts,
  editDraft,
  approveDraft,
  approveAllDrafts,
  discardDraft,
  draftsDirectory,
} from "../lib/draft-manager.js"

const program = new Command()

program.name("drafts").description("Manage pending decision drafts")

program
  .command("list", { isDefault: true })
  .description("List pending drafts")
  .action(async () => {
    const drafts = await listDrafts()

    if (drafts.length === 0) {
      console.log(`No pending drafts in ${draftsDirectory()}`)
      return
    }

    console.log(`Pending drafts (${drafts.length}):\n`)
    for (const draft of drafts) {
      console.log(`  ${draft.date}  [${draft.type}]  ${draft.decision}`)
      console.log(`    file: ${draft.fileName}\n`)
    }
  })

program
  .command("edit <fileName>")
  .description("Open a draft in $EDITOR")
  .action(async (fileName: string) => {
    await editDraft(fileName)
  })

program
  .command("approve [fileName]")
  .description("Approve and index a draft")
  .option("--all", "Approve all pending drafts")
  .action(async (fileName: string | undefined, opts: { all?: boolean }) => {
    if (opts.all) {
      const results = await approveAllDrafts()

      if (results.length === 0) {
        console.log("No drafts to approve.")
        return
      }

      for (const result of results) {
        console.log(`Approved ${result.fileName} -> ${result.approvedPath} (${result.documentedEdges} graph edges)`)
      }
      console.log(`\nApproved ${results.length} draft(s) and indexed them as decisions.`)
      return
    }

    if (!fileName) {
      throw new Error("Provide a draft file name, or use --all.")
    }

    const result = await approveDraft(fileName)
    console.log(`Approved ${result.fileName}`)
    console.log(`  moved to: ${result.approvedPath}`)
    console.log(`  indexed as: ${result.chunkType} (retrieval_priority 10)`)
    console.log(`  graph edges added: ${result.documentedEdges}`)
  })

program
  .command("discard <fileName>")
  .description("Discard a draft without indexing")
  .action(async (fileName: string) => {
    await discardDraft(fileName)
    console.log(`Discarded ${fileName}`)
  })

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
