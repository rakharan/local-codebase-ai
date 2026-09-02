import path from "node:path"
import fs from "node:fs/promises"
import { Command } from "commander"
import { qdrant } from "./lib/qdrant.js"
import { config, setChatModel } from "./lib/config.js"
import { createEmbedding, chat, resolveChatProvider, resolveChatBaseUrlHost } from "./lib/ollama.js"
import { readRelationshipGraph } from "./lib/graph.js"
import { bm25Search, isIdentifierQuery } from "./lib/bm25-index.js"
import { dlog, nowMs, elapsedMs, timeStage, isDebugEnabled } from "./lib/debug-log.js"
import { buildRegistryPromptContext, expandQuestionWithRegistry, type RegistryExpansion, type ServiceRegistryEntry } from "./lib/service-registry.js"
import { normalizeProjectIds, reposForProjectIds } from "./lib/service-registry.js"
import { accountTypeRelevantSourceChunks, buildAccountTypeGlossaryAnswer, buildAccountTypeNotFoundAnswer, buildPlatformTypeGlossaryAnswer } from "./ask/account-types.js"
import { compactPayloadSources, compactRetrievedChunks } from "./ask/compaction.js"
import { buildDoctorInventoryAnswer } from "./ask/doctor.js"
import { evaluateAnswerQuality, logQualityEvaluation } from "./ask/answer-evaluation.js"
import { loadActiveLearningRules, formatRulesForPrompt } from "./lib/learning-rules.js"
import { answerLanguageLabel as answerLanguageLabelFor, detectAnswerLanguage, heuristicAnswerLanguage, localizeAnswer as localizeAnswerFor, localized as localizedFor, shouldAnswerIndonesian as shouldAnswerIndonesianFor } from "./ask/language.js"
import { escapeRegExp, extractConceptTokens, extractDefinitionSubjectTerms, extractQuestionAcronyms, extractQuestionHints, extractQuestionRoutes, extractShortSubjectTokens, isConversationalFollowUp, isGreeting, questionAsksAboutAccountTypes, questionAsksAboutDatabase, questionAsksAboutGlossary, questionAsksAboutServicesOrFlow, questionAsksForDiagram, questionAsksHowWorks, questionAsksInventory, questionAsksMedalMechanism, questionBrokerHint, questionMetaTraderTerm, unique } from "./ask/question.js"
import type { AnswerLanguage } from "./lib/ollama.js"
import type { RelationshipEdge } from "./lib/graph.js"
import type { RelationshipHints } from "./lib/relationships.js"
import type { ServiceType } from "./lib/chunker.js"
import type {
  GraphFlowAnswer,
  GraphPathDetails,
  HandlerRef,
  MethodWindow,
  RetrievedChunk,
  RetrievedPayload,
  RouteDefinition,
} from "./ask/types.js"
import { extractQuestionTerms } from "./lib/vocabulary.js"

import { runDeepInvestigation, selectEndpointSources, type DeepInvestigation } from "./ask/deep.js"
import { buildDocumentationGlossaryAnswer, documentationGlossarySourceChunks } from "./ask/documentation-glossary.js"
import { buildEvidenceInventory, buildStructuralEvidenceAnswer, evidenceConfidenceLabel, extractCodeDerivedFacts, extractSqlTableNamesFromContent, payloadSource, sanitizeTableNames } from "./ask/evidence.js"
import { buildExactSymbolAnswer, describeMethodBody, extractNamedSymbolsFromQuestion } from "./ask/exact-symbol.js"
import { buildExpansionQueries, mergeChunks, shouldExpandExactRouteQuestion, shouldExpandRetrieval, shouldInspectExactEndpointDetails } from "./ask/expansion.js"
import { buildFilter, payloadMatchesFilter, repoBranchFileFilter, type SearchFilter } from "./ask/filter.js"
import { buildGraphFlowAnswer, buildGraphFlowContext, commonPathPrefixScore, describeGraphSymbolEdges, discoverGraphRouteAnchors, edgeSource, edgeTextForConceptSearch, edgeTextForTokenMatch, findCallsFromSymbols, findGraphHandlerDefinitions, findGraphSymbolDefinitions, findRelatedGraphTableEdges, formatGraphPathDetails, graphCandidateKey, graphCandidateMatchesTokens, graphScopeAllows, graphTextHasToken, handlerMethodName, mentionedGraphRepos, receiverMatchesDefinition, resolveGraphPath, sameRepoBranchFile, scoreGraphCallEdge, selectGraphFlowCandidates } from "./ask/graph-flow.js"
import { buildMermaidDiagramAnswer, extractMermaidBlocks, scoreMermaidBlock, stripDocChunkMetadata, type MermaidDiagramAnswer } from "./ask/mermaid.js"
import { buildCronDiscoveryAnswer, buildFunctionExistenceAnswer, buildNegativeRepoEvidenceAnswer, buildQueueMetadataAnswer, buildRouteDiscoveryAnswer, mentionedReposFromQuestion, questionAsksForCronListing, questionAsksForQueueLookup, questionAsksForRouteListing, questionAsksFunctionExistence, questionAsksNegativeRepoConstraint, queueLikeStringsFromContent, queueTermsFromQuestion, routeDiscoveryTerms, type MetadataAnswer } from "./ask/metadata-answers.js"
import { chunkHasStrongQuestionEvidence, collectHints, rerankRetrievedChunks, scoreFallbackContextChunk, selectFallbackContextChunks } from "./ask/rerank.js"
import { resolveHandlerChunks, retrieve, retrieveAccountTypeFileChunks, retrieveChunksByIds, retrieveCodeFromDocReferences, retrieveDocSectionSiblings, retrieveDocumentationSubjectMatches, retrieveExactRouteDetails, retrieveExactRouteMatches, retrieveExactTermMatches, retrieveExactTermMatchesViaScroll, retrieveExactVocabularyMatches, retrieveFileChunks, retrieveMetaTraderTermMatches, retrieveMinimumEquityConfigChunks, retrieveNeighborChunks, retrievePreferredLocaleDocChunks, retrieveVocabularyChunks } from "./ask/retrieve.js"
import { buildExactEndpointDetailAnswer, buildExactRouteComparisonAnswer, buildLineMap, containsExactIdentifier, contentContainsRoute, discoverConceptRouteAnchors, extractDownstreamRpcFacts, extractEndpointHandlerFacts, extractExactRouteHandlerRefs, extractGenericDownstreamRpcFacts, extractHandlerFactSummary, extractPhpConstantNamesForRoutes, extractPhpConstantRoutes, extractRouteDefinitions, extractRouteDefinitionsForSymbol, extractRouteHandlerRefs, extractRpcAndCallTerms, extractRpcFuncNames, extractRpcFuncNamesFromFacts, extractUpstreamRouteCallerFacts, findMethodWindow, isExactRouteComparisonQuestion, metadataTextForConceptSearch, normalizeRoute, orderRouteDefinitions, parseRequireAliases, parseRouteDefinition, registryExactSearchTerms, routeMatches, routeMatchesConceptTokens, scoreConceptAnchor, scoreExactTermMatch, textForExactSearch } from "./ask/route-analysis.js"
import { buildCommentRuleAnswer, buildDocumentationEligibilityAnswer, buildDocumentationTimelineAnswer, buildMedalMechanismAnswer, buildMetaTraderTermAnswer, buildMinimumEquityConfigAnswer, buildRegistryAliasDefinitionAnswer, cleanDocSummaryText, docLocaleForChunk, extractMinimumEquityConfigFacts, isCronDocChunk, normalizeRegistryAlias, questionAsksEligibilityRequirement, questionAsksMinimumEquityConfig, questionAsksProjectTimeline, registryAliasMatchesTerm, renderDocSummaryText, scoreDocLocalePreference, type MinimumEquityConfigFact } from "./ask/specialized-answers.js"
import { buildVocabularyAnswer } from "./ask/vocabulary-answers.js"
import { ctx } from "./ask/context.js"
import { neuralRerankFallback } from "./lib/reranker.js"
import { routeModel } from "./ask/model-router.js"


// Populate shared context for extracted modules — must be after all const declarations above

const serviceTypes = new Set<ServiceType>(["api", "worker", "cron", "library", "unknown"])

const program = new Command()

program
  .argument("<question...>", "Question to ask")
  .option("--limit <limit>", "Number of chunks to retrieve", "8")
  .option("--deep", "Run bounded read-only multi-step investigation before answering")
  .option("--repo-name <repoName>", "Only search one indexed repository")
  .option("--project <projectId>", "Only search one project/product/domain")
  .option("--branch <branchName>", "Only search one indexed branch")
  .option("--service-type <serviceType>", "Only search one service type")
  .option("--chat-model <model>", "Ollama chat model override for this question")
  .option("--history <json>", "JSON string of previous conversation messages")
  .parse()

const question = program.args.join(" ")
const options = program.opts<{ limit: string; deep?: boolean; repoName?: string; project?: string; branch?: string; serviceType?: string; chatModel?: string; history?: string }>()
if (options.chatModel) {
  setChatModel(options.chatModel)
}
const limit = Number(options.limit)
const deepMode = Boolean(options.deep)
const serviceType = options.serviceType && serviceTypes.has(options.serviceType as ServiceType)
  ? (options.serviceType as ServiceType)
  : undefined

function parseHistory(json?: string): Array<{ role: string; content: string }> {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((m: unknown) => {
      const msg = m as Record<string, unknown>
      return typeof msg.role === "string" && typeof msg.content === "string"
    })
  } catch {
    return []
  }
}

const history = parseHistory(options.history)
const registryExpansion = expandQuestionWithRegistry(question)
const retrievalQuestion = registryExpansion.expandedQuestion
const projectFilterIds = normalizeProjectIds(options.project ? [options.project] : [])
const projectFilterRepos = new Set(reposForProjectIds(projectFilterIds))
let answerLanguage: AnswerLanguage = "unknown"

// Per-query retrieval degradation flags. Reset at the start of each query in
// main() so a degraded state from a previous question does not leak forward.
// Surfaced in the answer output so the user/ops knows keyword search was
// unavailable and the answer is based on vector results only.
const retrievalDegradation = { bm25Unavailable: false }

// Per-request in-memory cache of file-scoped chunk scrolls. Keyed by
// `repoName|branchName|filePath`. Avoids re-scrolling the same file when
// retrieveFileChunks / retrieveNeighborChunks / resolveHandlerChunks all
// touch the same file within one /api/ask request. Reset at the start of
// main() so it never leaks across requests in long-lived processes.
const _fileChunkCache = new Map<string, RetrievedChunk[]>()

// Set true when main() completes the full retrieval+answer path (vs early returns).
let _askCompletedFull = false
const _askMainStart = nowMs()

// Populate shared context for extracted modules
Object.assign(ctx, {
  question,
  retrievalQuestion,
  limit,
  deepMode,
  serviceType,
  repoName: options.repoName,
  branch: options.branch,
  projectFilterIds,
  projectFilterRepos,
  registryExpansion,
  retrievalDegradation,
  fileChunkCache: _fileChunkCache,
  answerLanguage,
  history,
})

export function shouldAnswerIndonesian(question: string): boolean {
  return shouldAnswerIndonesianFor(question, answerLanguage)
}
function answerLanguageLabel(question: string): string {
  return answerLanguageLabelFor(question, answerLanguage)
}
export function localized(id: string, en: string): string {
  return localizedFor(question, answerLanguage, id, en)
}
function localizeAnswer(answer: string, question: string): string {
  return localizeAnswerFor(answer, question, answerLanguage)
}
async function main() {
  const mainStart = nowMs()
  routeModel(question, deepMode, Boolean(options.chatModel))
  const provider = resolveChatProvider()
  dlog("ask-start", {
    provider,
    chatBaseUrlHost: resolveChatBaseUrlHost(),
    chatModel: config.chatModel,
    embeddingModel: config.embeddingModel,
    embeddingUrl: config.ollamaUrl,
    qdrantUrl: config.qdrantUrl,
    deep: deepMode,
    limit,
    repoName: options.repoName ?? "-",
    project: options.project ?? "-",
    branch: options.branch ?? "-",
    serviceType: serviceType ?? "-",
    questionChars: question.length,
  })

  // Gate: greetings and short conversational follow-ups skip retrieval entirely.
  // Returns a direct response with no sources — avoids polluting results with
  // irrelevant chunks (e.g. SMTP HELO matching "hello").
  if (isGreeting(question)) {
    answerLanguage = heuristicAnswerLanguage(question)
    const greeting = shouldAnswerIndonesian(question)
      ? "Halo. Ada yang bisa saya bantu seputar codebase? Silakan tanya."
      : "Hello. Ready to help with codebase questions."
    console.log("\nANSWER\n")
    console.log(greeting)
    console.log("\nSOURCES\n")
    _askCompletedFull = true
    return
  }

  if (isConversationalFollowUp(question, history.length > 0)) {
    answerLanguage = heuristicAnswerLanguage(question)
    const historyLines = history.length > 0
      ? [
          "Previous conversation:",
          ...history.map(h => `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`),
          "",
        ]
      : []
    const convoPrompt = [
      ...historyLines,
      `User: ${question}`,
      "",
      "Answer the user's message conversationally. If they're referencing something from the previous conversation, use that context. If they seem frustrated or confused, acknowledge and offer help. Keep it brief. Do not reference codebase sources.",
    ].join("\n")
    const convoAnswer = await chat(convoPrompt)
    console.log("\nANSWER\n")
    console.log(localizeAnswer(convoAnswer, question))
    console.log("\nSOURCES\n")
    _askCompletedFull = true
    return
  }

  retrievalDegradation.bm25Unavailable = false
  _fileChunkCache.clear()
  answerLanguage = await timeStage("language", () => detectAnswerLanguage(question))

  const questionRoutes = extractQuestionRoutes(question)
  const relationshipGraph = await timeStage("graph-load", () => readRelationshipGraph())
  const negativeRepoConstraint = questionAsksNegativeRepoConstraint(question)

  if (negativeRepoConstraint) {
    const negativeRepoAnswer = await buildNegativeRepoEvidenceAnswer(question)

    if (negativeRepoAnswer) {
      console.log("\nANSWER\n")
      console.log(localizeAnswer(negativeRepoAnswer.answer, question))

      console.log("\nSOURCES\n")
      console.log(negativeRepoAnswer.sources.join("\n"))

      return
    }
  }

  if (questionRoutes.length === 0 && !negativeRepoConstraint) {
    const graphFlowAnswer = await buildGraphFlowAnswer(question, relationshipGraph)

    if (graphFlowAnswer) {
      console.log("\nANSWER\n")
      const answer = deepMode
        ? [
            localized("Investigation trace:", "Investigation trace:"),
            localized("- Step 1: mencari anchor flow di relationship graph yang ter-index.", "- Step 1: searched indexed relationship graph for flow anchors."),
            localized("- Step 2: menemukan path terkonfirmasi dari edge route/caller/handler yang saling cocok.", "- Step 2: found a confirmed path from matching route/caller/handler edges."),
            localized("- Step 3: menjawab hanya dari source graph/chunk yang terkonfirmasi.", "- Step 3: answered only from confirmed graph/chunk sources."),
            "",
            graphFlowAnswer.answer,
          ].join("\n")
        : graphFlowAnswer.answer

      console.log(localizeAnswer(answer, question))

      console.log("\nSOURCES\n")

      for (const edge of graphFlowAnswer.sources) {
        console.log(`- ${edgeSource(edge)} (${edge.type})`)
      }

      return
    }

    // Decision-intent questions should not be intercepted by the queue metadata path,
    // even when they mention AMQP/queue terms as part of the subject being decided about.
    const isDecisionQuestion = /\b(decided|decision|why|rationale|rule|changed|aturan|diputuskan|alasan)\b/i.test(question)
    const queueMetadataAnswer = isDecisionQuestion ? undefined : await buildQueueMetadataAnswer(question, relationshipGraph)

    if (queueMetadataAnswer) {
      // Feed queue evidence into LLM for synthesis instead of raw dump
      const queueContext = queueMetadataAnswer.answer
      const queuePrompt = [
        `Question: ${question}`,
        `Answer language: ${answerLanguageLabel(question)}`,
        "",
        "Queue/messaging evidence from relationship graph and indexed code:",
        queueContext,
        "",
        "Answer requirements:",
        "- Synthesize the queue evidence above into a clear, readable explanation.",
        "- Explain the flow: which service publishes, which queue/exchange, which service consumes.",
        "- Mention specific file paths and line numbers from the evidence.",
        "- If a step in the flow is missing from the evidence, say so explicitly.",
        "- Do not repeat the raw evidence table — synthesize it into prose.",
        "- Say NOT_FOUND_IN_INDEXED_CODEBASE only if the evidence contains nothing relevant.",
      ].join("\n")

      console.log("\nANSWER\n")
      const synthesized = await chat(queuePrompt)
      console.log(localizeAnswer(synthesized, question))
      console.log("\nSOURCES\n")
      console.log(queueMetadataAnswer.sources.join("\n"))
      return
    }

    const cronDiscoveryAnswer = await buildCronDiscoveryAnswer(question, relationshipGraph)

    if (cronDiscoveryAnswer) {
      console.log("\nANSWER\n")
      console.log(localizeAnswer(cronDiscoveryAnswer.answer, question))

      console.log("\nSOURCES\n")
      console.log(cronDiscoveryAnswer.sources.join("\n"))

      return
    }

    const functionExistenceAnswer = await buildFunctionExistenceAnswer(question, relationshipGraph)

    if (functionExistenceAnswer) {
      console.log("\nANSWER\n")
      console.log(localizeAnswer(functionExistenceAnswer.answer, question))

      console.log("\nSOURCES\n")
      console.log(functionExistenceAnswer.sources.join("\n"))

      return
    }

    const routeDiscoveryAnswer = buildRouteDiscoveryAnswer(question, relationshipGraph)

    if (routeDiscoveryAnswer) {
      console.log("\nANSWER\n")
      console.log(localizeAnswer(routeDiscoveryAnswer.answer, question))

      console.log("\nSOURCES\n")
      console.log(routeDiscoveryAnswer.sources.join("\n"))

      return
    }
  }

  const shouldDiscoverConceptRoutes = questionRoutes.length === 0 &&
    !negativeRepoConstraint &&
    questionAsksAboutServicesOrFlow(question) &&
    !questionAsksHowWorks(question) &&
    !questionAsksInventory(question)
  const conceptRoutes = shouldDiscoverConceptRoutes
    ? await timeStage("concept-route-discovery", async () =>
        unique([...discoverGraphRouteAnchors(question, relationshipGraph), ...await discoverConceptRouteAnchors(question)], 10))
    : []
  const exactRoutes = unique([...questionRoutes, ...conceptRoutes], 10)
  const exactRouteStart = nowMs()
  const exactChunks = await retrieveExactRouteMatches(exactRoutes)
  dlog("stage", { name: "exact-route-match", ms: elapsedMs(exactRouteStart), exactRoutes: exactRoutes.length, chunks: exactChunks.length })

  // BM25 symbol lookup — runs independently of vector search for identifier queries
  const symbolIdentifiers = extractQuestionHints(question).filter(t => isIdentifierQuery(t))
  const symbolChunks: RetrievedChunk[] = symbolIdentifiers.length > 0
    ? await timeStage("bm25-symbol", async () => {
        const bm25Results = await bm25Search(symbolIdentifiers.join(" "), 8)
        if (bm25Results.length === 0) return []
        try {
          const points = await qdrant.retrieve(config.collectionName, {
            ids: bm25Results.map(r => r.id),
            with_payload: true,
          })
          return points
            .map(p => ({ id: String(p.id), payload: p.payload as RetrievedPayload }))
            .filter(c => c.payload.content)
        } catch (err) {
          console.error("BM25 symbol retrieve failed:", err instanceof Error ? err.message : err)
          return []
        }
      })
    : []
  const questionHints = extractQuestionHints(question)
  const generalVocabKeywords = ["medal", "level", "rank", "persyaratan", "naik", "requirement", "syarat", "tier", "grade"]
  const isGeneralVocabQuestion = generalVocabKeywords.some(kw => question.toLowerCase().includes(kw))

  const vocabBoostTerms = isGeneralVocabQuestion
    ? ["POINT_LEVELS", "RANGE_MEDAL", "minMedal", "maxMedal", "MEDALS", "levelToMedals"]
    : []
  const medalMechanismTerms = questionAsksMedalMechanism(question)
    ? [
        "dsc_channels_point_events",
        "dsc_channels_point_medal_journal",
        "dsc_channels_point_balance",
        "dsc_channels_point_redeem",
        "prev_channel_medal",
        "last_qualify_id",
        "total_pips",
        "qualify",
        "redeemPointAsync",
        "CHANNEL_LEVEL_NOT_ENOUGH",
        "CalculatePointAndMedal20260531",
        "current_month_vp",
        "minimum_vp",
        "average_monthly_vp",
        "signal_settled",
        "reset_channel",
      ]
    : []
  const metaTraderTerm = questionMetaTraderTerm(question)
  const metaTraderSearchTerms = metaTraderTerm
    ? [
        metaTraderTerm,
        "MetaTrader",
        "platform_type",
        "metaserver_id",
        "TF_METATRADER_PLATFORM_TYPE",
        "MRG_METATRADER_PLATFORM_TYPE",
        "ASKAP_METATRADER_PLATFORM_TYPE",
        "VOLUME_MULTIPLIER",
        "ServerPlatform",
      ]
    : []
  const minimumEquitySearchTerms = questionAsksMinimumEquityConfig(question)
    ? [
        "AUTO_COPY_MINIMUM_EQUITY",
        "minimumEquity",
        "minimum equity",
        "auto copy minimum equity",
        "equity",
      ]
    : []

  const exactTermSearchTerms = unique([
    ...questionHints,
    ...extractConceptTokens(question),
    ...registryExactSearchTerms(),
    ...vocabBoostTerms,
    ...medalMechanismTerms,
    ...metaTraderSearchTerms,
    ...minimumEquitySearchTerms,
  ], 48)
  // Run all independent exact-match scroll scans in parallel.
  const exactParallelStart = nowMs()
  const [exactTermChunks, exactVocabularyChunks, exactMetaTraderChunks, exactMinimumEquityChunks, isignalDocChunks] = await Promise.all([
    exactRoutes.length === 0
      ? retrieveExactTermMatches(exactTermSearchTerms, questionAsksAboutAccountTypes(question) ? 60 : 32)
      : Promise.resolve([]),
    exactRoutes.length === 0 && isGeneralVocabQuestion
      ? retrieveExactVocabularyMatches(exactTermSearchTerms, 24)
      : Promise.resolve([]),
    exactRoutes.length === 0 && metaTraderTerm
      ? retrieveMetaTraderTermMatches(metaTraderTerm, 64)
      : Promise.resolve([]),
    exactRoutes.length === 0 && questionAsksMinimumEquityConfig(question)
      ? retrieveMinimumEquityConfigChunks(24)
      : Promise.resolve([]),
    // Explicit isignal-docs scroll for timeline and eligibility questions — these specific
    // question types are not well-served by vector search when isignal has no docs:id locale.
    exactRoutes.length === 0 && (questionAsksProjectTimeline(question) || questionAsksEligibilityRequirement(question))
      ? (async (): Promise<RetrievedChunk[]> => {
          const result = await qdrant.scroll(config.collectionName, {
            filter: { must: [{ key: "repoName", match: { value: "isignal" } }, { key: "branchName", match: { value: "docs" } }] },
            limit: 100, with_payload: true, with_vector: false,
          })
          return result.points
            .map(p => ({ id: String(p.id), payload: p.payload as RetrievedPayload }))
            .filter(c => c.payload.content)
        })()
      : Promise.resolve([]),
  ])
  if (exactRoutes.length > 0) {
    dlog("stage", { name: "exact-term-parallel", status: "skipped", reason: "exact-routes-present" })
  } else {
    dlog("stage", {
      name: "exact-term-parallel",
      status: "executed",
      ms: elapsedMs(exactParallelStart),
      exactTerm: exactTermChunks.length,
      vocab: exactVocabularyChunks.length,
      metaTrader: exactMetaTraderChunks.length,
      equity: exactMinimumEquityChunks.length,
      isignal: isignalDocChunks.length,
    })
  }

  // Fallback: if the question is about general vocabulary topics (medal, level, rank) but no vocabulary
  // chunks were retrieved via exact matching, explicitly search for vocabulary chunks.
  const hasVocabChunks = [...exactTermChunks, ...exactVocabularyChunks].some(chunk => chunk.payload.filePath?.startsWith("vocabulary://"))

  let generalVocabChunks: RetrievedChunk[] = []

  if (isGeneralVocabQuestion && !hasVocabChunks) {
    generalVocabChunks = await retrieveVocabularyChunks(question, 16)
  }

  // If vocabulary chunks were found, also retrieve code chunks that reference
  // the vocabulary group names and their properties (e.g., POINT_LEVELS and level.money usage)
  const vocabGroupNames = new Set<string>()
  const vocabPropertyNames = new Set<string>()

  for (const chunk of [...exactTermChunks, ...exactVocabularyChunks]) {
    if (chunk.payload.filePath?.startsWith("vocabulary://")) {
      const lines = (chunk.payload.content ?? "").split("\n")
      const vocabName = lines.find(line => line.startsWith("Vocabulary:"))?.replace("Vocabulary:", "").trim()

      if (vocabName) vocabGroupNames.add(vocabName)

      // Extract property names from indented lines in the Terms section only
      let inTermsSection = false

      for (const line of lines) {
        if (line === "Terms:") {
          inTermsSection = true
          continue
        }

        if (line === "Context:") {
          inTermsSection = false
          continue
        }

        if (!inTermsSection) continue

        // Only capture property lines (4-space indented) under a term, not the term line itself
        if (line.startsWith("    ")) {
          const propMatch = line.match(/^\s{4}([^:]+):/)

          if (propMatch && propMatch[1]) {
            const propName = propMatch[1].trim().replace(/^["']|["']$/g, "")

            if (propName && propName !== "name" && propName !== "label") {
              vocabPropertyNames.add(propName)
            }
          }
        }
      }
    }
  }

  const vocabSearchTerms = [...vocabGroupNames]

  for (const prop of vocabPropertyNames) {
    vocabSearchTerms.push(prop)
    vocabSearchTerms.push(`level.${prop}`)
  }

  const vocabUsageChunks = vocabSearchTerms.length > 0
    ? await retrieveExactTermMatches(vocabSearchTerms, 48)
    : []

  const exactTermDetailChunks =
    exactRoutes.length === 0 && exactTermChunks.length > 0
      ? await timeStage("exact-term-detail-neighbors", () =>
          retrieveNeighborChunks(exactTermChunks, questionAsksAboutAccountTypes(question) ? 240 : 70))
      : []
  const exactComparison = exactRoutes.length >= 2 && isExactRouteComparisonQuestion(question)
  // Decision-intent questions should not be treated as endpoint inspections — they ask
  // about WHY something was decided, not HOW an endpoint behaves.
  // "rule"/"aturan" alone are too broad — they match glossary+rules questions like "apa itu FA dan aturan nya".
  // Require either an explicit decision verb OR "rule/aturan" paired with a decision subject word.
  const isDecisionIntentQuestion = /\b(decided|decision|rationale|changed|diputuskan|alasan|kenapa|mengapa)\b/i.test(question) ||
    (/\b(rule|aturan)\b/i.test(question) && /\b(why|kenapa|mengapa|diputus|adr|architectural)\b/i.test(question)) ||
    // "what does X = N mean" — value meaning questions should check decisions+migrations
    (/\b(mean|means|meaning|arti|artinya|maksud)\b/i.test(question) && /[=]\s*\d+/.test(question))
  const exactEndpointInspection =
    exactRoutes.length > 0 &&
    !exactComparison &&
    !isDecisionIntentQuestion &&
    (shouldInspectExactEndpointDetails(question) || shouldExpandExactRouteQuestion(question) || conceptRoutes.length > 0)
  const exactHandlerRefs = extractExactRouteHandlerRefs(exactChunks, exactRoutes)
  const exactDetailChunks =
    exactChunks.length > 0
      ? await timeStage("exact-route-details", () => retrieveExactRouteDetails(
          exactChunks,
          exactHandlerRefs,
          exactComparison || exactEndpointInspection || shouldExpandExactRouteQuestion(question),
          exactRoutes,
        ))
      : []
  const retrievalLimit = questionAsksAboutGlossary(question) ? Math.max(limit, 18) : limit

  // Fast path: inventory questions with Doctor chunks — filter-only, no embedding needed
  if (questionAsksInventory(question) && exactRoutes.length === 0) {
    const mentionedRepo = question.match(/\b([\w]+-[\w-]+|bpjs|bpts|ims-tf2?)\b/i)?.[1]?.toLowerCase()
    const doctorRepoName = mentionedRepo ? `${mentionedRepo}-docs` : undefined
    const asksServices = /\b(what services|services? (detected|list|available)|detected (services?|repos?))\b/i.test(question)
    const asksEnv = /\b(environment variables?|env vars?|process\.env|what env|which env)\b/i.test(question)
    const asksDbTables = /\b(database tables?|db tables?|which tables?|what tables?|tables? (used|detected)|touch|services.*touch|what.*touch)\b/i.test(question)
    const asksDeps = /\b(dependenc)/i.test(question)

    const doctorFileFilters: string[] = []
    if (asksServices || asksDeps) doctorFileFilters.push("doctor:overview.md", "doctor:services.md")
    if (asksEnv) doctorFileFilters.push("doctor:env.md")
    if (asksDbTables) doctorFileFilters.push("doctor:database.md")
    if (doctorFileFilters.length === 0) doctorFileFilters.push("doctor:overview.md")

    if (doctorRepoName) {
      // Single-repo path — repo mentioned in question
      try {
        const scrollFilter = {
          must: [
            { key: "repoName", match: { value: doctorRepoName } },
            { key: "branchName", match: { value: "doctor" } },
          ],
          should: doctorFileFilters.map(fp => ({ key: "filePath", match: { value: fp } })),
        }
        const scrollResult = await qdrant.scroll(config.collectionName, {
          filter: scrollFilter, limit: 20, with_payload: true, with_vector: false,
        })
        const doctorChunks = (scrollResult.points as Array<{ id: string | number; payload?: Record<string, unknown> | null }>)
          .map(p => p.payload as RetrievedPayload | undefined)
          .filter((p): p is RetrievedPayload => !!p?.content)

        if (doctorChunks.length > 0) {
          const summaryChunks = doctorChunks.filter(c => c.content?.includes('unique)') || c.content?.includes('# ') || c.content?.includes('## Summary'))
          const detailChunks = doctorChunks.filter(c => !summaryChunks.includes(c))
          const output = summaryChunks.length > 0
            ? [...summaryChunks, ...detailChunks.slice(0, 2)]
            : doctorChunks.slice(0, 8)

          // Synthesize via LLM instead of raw dump — same pattern as queue answer
          const inventoryContext = output.map(c => c.content ?? "").join("\n\n---\n\n")
          const inventoryPrompt = [
            `Question: ${question}`,
            `Answer language: ${answerLanguageLabel(question)}`,
            "",
            "Repo Doctor evidence for the requested service/repo:",
            inventoryContext,
            "",
            "Answer requirements:",
            "- Synthesize the evidence above into a clear, readable answer.",
            "- Group related facts (services, env vars, DB tables, dependencies) into sections.",
            "- Mention specific file paths and line numbers from the evidence.",
            "- If a section has no evidence, omit it rather than saying 'none found'.",
            "- Do not repeat raw markdown tables verbatim — summarize and highlight key facts.",
            "- Say NOT_FOUND_IN_INDEXED_CODEBASE only if the evidence contains nothing relevant.",
          ].join("\n")

          console.log("\nANSWER\n")
          const synthesized = await chat(inventoryPrompt)
          console.log(localizeAnswer(synthesized, question))
          console.log("\nSOURCES\n")
          for (const chunk of output) {
            console.log(`- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`)
          }
          return
        }
      } catch { /* no doctor chunks — fall through to normal retrieval */ }
    } else if (asksDbTables) {
      // Cross-repo path — no repo mentioned, fetch database.md from ALL doctor repos
      // Filter by any table name mentioned in the question
      const tableHints = [
        ...extractQuestionHints(question).filter(t => /^[a-z][a-z0-9]+_[a-z][a-z0-9_]+$/.test(t)),
        // also extract snake_case words directly from the question
        ...(question.match(/\b[a-z][a-z0-9]+(?:_[a-z][a-z0-9]+)+\b/g) ?? []),
      ].filter((v, i, a) => a.indexOf(v) === i) // dedupe

      try {
        const scrollFilter = {
          must: [
            { key: "branchName", match: { value: "doctor" } },
            { key: "filePath", match: { value: "doctor:database.md" } },
          ],
        }
        let offset: string | number | Record<string, unknown> | null | undefined
        const allDoctorDbChunks: RetrievedPayload[] = []

        do {
          const page = await qdrant.scroll(config.collectionName, {
            filter: scrollFilter, limit: 256, with_payload: true, with_vector: false,
            ...(offset ? { offset } : {}),
          })
          for (const p of page.points) {
            const payload = p.payload as RetrievedPayload | null | undefined
            if (!payload?.content) continue
            // if table hints extracted, only keep chunks mentioning those tables
            if (tableHints.length > 0) {
              const content = payload.content.toLowerCase()
              if (!tableHints.some(t => content.includes(t))) continue
            }
            allDoctorDbChunks.push(payload)
          }
          offset = page.next_page_offset
        } while (offset)

        if (allDoctorDbChunks.length > 0) {
          // Group by repo
          const byRepo = new Map<string, RetrievedPayload[]>()
          for (const chunk of allDoctorDbChunks) {
            const repo = chunk.repoName ?? "unknown"
            const list = byRepo.get(repo) ?? []
            list.push(chunk)
            byRepo.set(repo, list)
          }

          // For each repo, extract only lines matching the table hints
          const repoSummaries: Array<{ repo: string; chunk: RetrievedPayload; lines: string[] }> = []
          for (const [repo, chunks] of byRepo) {
            const matchingLines: string[] = []
            for (const chunk of chunks) {
              const lines = (chunk.content ?? "").split("\n")
              for (const line of lines) {
                if (tableHints.length === 0 || tableHints.some(t => line.toLowerCase().includes(t))) {
                  if (line.startsWith("|") || line.startsWith("#")) matchingLines.push(line)
                }
              }
            }
            if (matchingLines.length > 0) {
              repoSummaries.push({ repo, chunk: chunks[0]!, lines: matchingLines.slice(0, 20) })
            }
          }

          if (repoSummaries.length > 0) {
            console.log("\nANSWER\n")
            console.log(`Services that touch \`${tableHints.join(", ")}\` (Repo Doctor, ${repoSummaries.length} repos):\n`)
            for (const { repo, lines } of repoSummaries) {
              console.log(`### ${repo}`)
              console.log(lines.join("\n"))
              console.log("")
            }
            console.log("\nSOURCES\n")
            for (const { chunk } of repoSummaries) {
              console.log(`- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`)
            }
            return
          }
        }
      } catch { /* fall through */ }
    }
  }

  // Apply retrieval boost from learning rules — append boost terms to BM25 queries
  const activeRules = await loadActiveLearningRules()
  const boostTerms = activeRules
    .filter(r => r.type === "retrieval_boost" && question.toLowerCase().includes(r.trigger.toLowerCase()))
    .map(r => r.content)
    .join(" ")
  const boostedRetrievalQuestion = boostTerms ? `${retrievalQuestion} ${boostTerms}` : retrievalQuestion

  // Run independent retrieval calls in parallel to avoid sequential Qdrant round-trips.
  const isGlossaryNotAccountTypes = exactRoutes.length === 0 && questionAsksAboutGlossary(question) && !questionAsksAboutAccountTypes(question)
  const vectorParallelStart = nowMs()
  const [
    initialChunks,
    preferredLocaleDocChunksRaw,
    exactDocumentationSubjectChunksRaw,
  ] = await Promise.all([
    exactRoutes.length > 0 ? Promise.resolve([]) : retrieve(boostedRetrievalQuestion, retrievalLimit),
    isGlossaryNotAccountTypes
      ? retrievePreferredLocaleDocChunks(retrievalQuestion, Math.max(retrievalLimit, 16))
      : Promise.resolve([]),
    isGlossaryNotAccountTypes && !isGeneralVocabQuestion
      ? retrieveDocumentationSubjectMatches([
          ...extractConceptTokens(question),
          ...extractDefinitionSubjectTerms(question),
          ...extractQuestionAcronyms(question),
          ...extractShortSubjectTokens(question),
        ], Math.max(retrievalLimit, 24))
      : Promise.resolve([]),
  ])
  if (exactRoutes.length > 0) {
    dlog("stage", { name: "vector-retrieval-parallel", status: "skipped", reason: "exact-routes-present" })
  } else {
    dlog("stage", {
      name: "vector-retrieval-parallel",
      status: "executed",
      ms: elapsedMs(vectorParallelStart),
      initial: initialChunks.length,
      preferredLocaleDoc: (preferredLocaleDocChunksRaw as RetrievedChunk[]).length,
      docSubject: (exactDocumentationSubjectChunksRaw as RetrievedChunk[]).length,
    })
  }

  // Learning rules: BM25 boost search — find chunks containing boost terms that
  // vector search missed. Merge into initialChunks before reranking.
  if (boostTerms) {
    const boostStart = nowMs()
    const bm25BoostResults = await bm25Search(boostTerms, Math.max(retrievalLimit * 4, 48))
    const existingIds = new Set(initialChunks.map(c => c.id))
    const missingBoostIds = bm25BoostResults.map(r => r.id).filter(id => !existingIds.has(id))
    if (missingBoostIds.length > 0) {
      try {
        const boostPoints = await qdrant.retrieve(config.collectionName, {
          ids: missingBoostIds.slice(0, 24),
          with_payload: true,
        })
        for (const point of boostPoints) {
          const payload = point.payload as RetrievedPayload
          if (payload?.content) {
            initialChunks.push({ id: String(point.id), payload })
          }
        }
      } catch { /* fall through */ }
    }
    dlog("stage", { name: "bm25-boost", ms: elapsedMs(boostStart), boostResults: bm25BoostResults.length, merged: missingBoostIds.length })
  }
  const preferredLocaleDocChunks = (preferredLocaleDocChunksRaw as RetrievedChunk[]).filter(chunk => {
    // When the question is about a specific product (isignal, FA, etc.), exclude unrelated repos
    // so the docs:id locale for a different product doesn't dominate.
    const repoName = chunk.payload.repoName?.toLowerCase() ?? ""
    const filePath = chunk.payload.filePath?.toLowerCase() ?? ""
    if (registryExpansion.terms.map(t => t.toLowerCase()).includes("isignal")) {
      // isignal has no docs:id — drop docs:id chunks from other repos to avoid pollution
      if (!repoName.includes("isignal") && !filePath.includes("isignal")) return false
    }
    return true
  })
  const exactDocumentationSubjectChunks = exactDocumentationSubjectChunksRaw as RetrievedChunk[]
  const docNeighborStart = nowMs()
  const [preferredLocaleDocNeighborChunks, exactDocumentationSubjectNeighborChunks] = await Promise.all([
    preferredLocaleDocChunks.length > 0 && questionAsksAboutGlossary(question)
      ? retrieveNeighborChunks(preferredLocaleDocChunks, 30)
      : Promise.resolve([]),
    exactDocumentationSubjectChunks.length > 0 && questionAsksAboutGlossary(question)
      ? retrieveNeighborChunks(exactDocumentationSubjectChunks, 40)
      : Promise.resolve([]),
  ])
  if (preferredLocaleDocChunks.length > 0 || exactDocumentationSubjectChunks.length > 0) {
    dlog("stage", {
      name: "doc-neighbor-retrieval",
      ms: elapsedMs(docNeighborStart),
      preferredLocaleNeighbors: preferredLocaleDocNeighborChunks.length,
      docSubjectNeighbors: exactDocumentationSubjectNeighborChunks.length,
    })
  }
  const hints = collectHints([...exactChunks, ...exactDetailChunks, ...exactTermChunks, ...exactVocabularyChunks, ...exactMetaTraderChunks, ...exactMinimumEquityChunks, ...isignalDocChunks, ...exactTermDetailChunks, ...vocabUsageChunks, ...exactDocumentationSubjectChunks, ...initialChunks])
  const expansionQueries =
    exactEndpointInspection
      ? []
      : exactRoutes.length > 0 && exactChunks.length === 0
        ? []
      : exactRoutes.length > 0 && !shouldExpandExactRouteQuestion(question)
        ? []
      : shouldExpandRetrieval(question, hints)
        ? buildExpansionQueries(question, hints)
        : []
  const expandedChunks = []

  const expansionStart = nowMs()
  for (const expansionQuery of expansionQueries) {
    expandedChunks.push(...await retrieve(`${expansionQuery}\n${registryExpansion.terms.join(" ")}`, Math.max(3, Math.ceil(retrievalLimit / 2))))
  }
  if (expansionQueries.length > 0) {
    dlog("stage", { name: "expansion-retrieval", ms: elapsedMs(expansionStart), queries: expansionQueries.length, chunks: expandedChunks.length })
  }

  // Bridge vocabulary gap: extract code identifiers from retrieved documentation
  // chunks and find the actual implementation code they reference.
  // First, expand to sibling docs from the same doc section — e.g., if we found
  // isignal-docs/edge-cases.md, also fetch cron-jobs/index.md which contains
  // specific identifiers (CronCheckDeals, etc.) that lead to implementation code.
  const docChunksForExpansion = [...preferredLocaleDocChunks, ...exactDocumentationSubjectChunks, ...isignalDocChunks, ...preferredLocaleDocNeighborChunks, ...exactDocumentationSubjectNeighborChunks]
  const docSectionStart = nowMs()
  const docSectionSiblings = docChunksForExpansion.length > 0
    ? await retrieveDocSectionSiblings(docChunksForExpansion, 24)
    : []
  if (docSectionSiblings.length > 0) {
    dlog("stage", { name: "doc-section-expansion", ms: elapsedMs(docSectionStart), siblingDocs: docSectionSiblings.length })
  }
  const docChunksForCodeRef = [...docChunksForExpansion, ...docSectionSiblings]
  const docRefStart = nowMs()
  const docRefCodeChunks = docChunksForCodeRef.length > 0
    ? await retrieveCodeFromDocReferences(docChunksForCodeRef, Math.max(retrievalLimit, 24))
    : []
  if (docRefCodeChunks.length > 0) {
    dlog("stage", { name: "doc-ref-code-retrieval", ms: elapsedMs(docRefStart), codeChunks: docRefCodeChunks.length })
  }

  // For decision-intent questions, always fetch approved decision chunks directly
  // and prepend them — they must not compete for slots against code chunks.
  const decisionChunks: RetrievedChunk[] = isDecisionIntentQuestion
    ? await timeStage("decision-chunks", async () => {
        const result = await qdrant.scroll(config.collectionName, {
          filter: { must: [{ key: "source_type", match: { value: "decision" } }] },
          limit: 20,
          with_payload: true,
          with_vector: false,
        })
        return result.points
          .map(point => ({ id: String(point.id), payload: point.payload as RetrievedPayload }))
          .filter(chunk => chunk.payload.content)
      })
    : []

  const mergeStart = nowMs()
  const retrievedChunks = mergeChunks(
    [
      ...decisionChunks,
      ...exactChunks,
      ...symbolChunks,
      ...exactDetailChunks,
      // Code chunks from doc-ref retrieval go early — compactRetrievedChunks is
      // first-come-first-served, so code must be ahead of docs to survive the limit.
      ...docRefCodeChunks,
      // isignalDocChunks first — they are explicitly scrolled for timeline/eligibility
      // questions and must not be crowded out by docs:id chunks from other repos
      ...isignalDocChunks,
      ...preferredLocaleDocChunks,
      ...preferredLocaleDocNeighborChunks,
      ...exactDocumentationSubjectChunks,
      ...exactDocumentationSubjectNeighborChunks,
      ...docSectionSiblings,
      ...exactTermChunks,
      ...exactVocabularyChunks,
      ...exactMetaTraderChunks,
      ...exactMinimumEquityChunks,
      ...generalVocabChunks,
      ...vocabUsageChunks,
      ...exactTermDetailChunks,
      ...initialChunks,
      ...expandedChunks,
    ],
    exactRoutes.length > 0
      ? Math.max(limit, 24)
      : questionAsksAboutAccountTypes(question)
        ? Math.max(retrievalLimit, 36)
        : questionAsksAboutGlossary(question)
        ? Math.max(retrievalLimit, 96)
        : (questionAsksProjectTimeline(question) || questionAsksEligibilityRequirement(question))
        ? Math.max(limit, 48)
        : Math.max(limit, 12),
  )
  dlog("stage", { name: "merge-chunks", ms: elapsedMs(mergeStart), retrievedChunks: retrievedChunks.length })

  // Neural reranker: re-score top chunks using BGE cross-encoder.
  // Runs after heuristic merge, before account-type/deep-investigation expansion.
  // Falls back to heuristic order if reranker unavailable.
  let rerankedChunks = retrievedChunks
  if (retrievedChunks.length > 0) {
    rerankedChunks = await timeStage("neural-rerank", () =>
      neuralRerankFallback(question, retrievedChunks),
    )
  }

  const accountTypeFileChunks = questionAsksAboutAccountTypes(question)
    ? await timeStage("account-type-file-chunks", () => retrieveAccountTypeFileChunks(rerankedChunks, question))
    : []
  const answerChunks = accountTypeFileChunks.length > 0
    ? mergeChunks([...rerankedChunks, ...accountTypeFileChunks], Math.max(retrievalLimit, 320))
    : rerankedChunks
  const deepInvestigation = deepMode
    ? await runDeepInvestigation(question, relationshipGraph, answerChunks, exactRoutes, exactTermSearchTerms, hints)
    : undefined
  const finalAnswerChunks = deepInvestigation
    ? mergeChunks([...answerChunks, ...deepInvestigation.chunks], Math.max(retrievalLimit, 64))
    : answerChunks
  // For decision-intent questions, only send decision chunks to the LLM — code chunks
  // are noise that causes smaller models to ignore the actual decision content.
  const chunks = (isDecisionIntentQuestion && decisionChunks.length > 0
    ? finalAnswerChunks.filter(chunk => chunk.payload.source_type === "decision")
    : finalAnswerChunks
  ).map(chunk => chunk.payload)
  const routeDefinitions = orderRouteDefinitions(extractRouteDefinitions(exactChunks, exactRoutes), exactRoutes)
  const exactRouteRepoNames = unique(exactChunks.map(chunk => chunk.payload.repoName ?? ""), 12)
  const handlerFacts = extractHandlerFactSummary(exactDetailChunks, exactHandlerRefs, exactRouteRepoNames)
  const endpointFacts = extractEndpointHandlerFacts(exactDetailChunks, exactHandlerRefs, exactRouteRepoNames)
  const endpointRpcFuncNames = extractRpcFuncNamesFromFacts(endpointFacts)
  // Skip endpoint-extra-terms when exactDetailChunks already contain the
  // relevant downstream evidence (deposit_demo / users_demoid / RPC func).
  // The extra retrieval is only needed when the route-details stage didn't
  // already surface the downstream model chunks.
  const hasDownstreamEvidence = exactDetailChunks.some(c => {
    const content = c.payload.content ?? ""
    return content.includes("deposit_demo") || content.includes("users_demoid") || endpointRpcFuncNames.some(name => content.includes(name))
  })
  const endpointExtraTermChunks = endpointRpcFuncNames.some(name => /SubmitDepositDemo/i.test(name)) && !hasDownstreamEvidence
    ? await timeStage("endpoint-extra-terms", () =>
        retrieveExactTermMatches(["deposit_demo", "users_demoid", "SubmitDepositDemo"], 12))
    : []
  if (endpointRpcFuncNames.some(name => /SubmitDepositDemo/i.test(name)) && hasDownstreamEvidence) {
    dlog("stage", { name: "endpoint-extra-terms", status: "skipped", reason: "downstream-evidence-already-present" })
  }
  const endpointDetailEvidenceChunks = [...exactDetailChunks, ...endpointExtraTermChunks]
  const phpConstantNamesForExactRoutes = extractPhpConstantNamesForRoutes(exactChunks, exactRoutes)
  // Compute upstream facts from existing evidence first. Only run the PHP
  // caller fallback (php-caller-chunks) when no upstream facts were found
  // and no PHP constants were extracted — avoids ~85ms BM25+retrieve when
  // the evidence is already present.
  const upstreamConstantNames = phpConstantNamesForExactRoutes.length > 0
    ? phpConstantNamesForExactRoutes
    : endpointDetailEvidenceChunks.flatMap(c =>
        [...(c.payload.content ?? "").matchAll(/\bHelper::requestAPI\s*\(\s*(?:[A-Z][A-Za-z0-9_]*::)?([A-Z][A-Z0-9_]+)/g)]
          .map(m => m[1] ?? "")
          .filter(Boolean)
      )
  const preliminaryUpstreamFacts = extractUpstreamRouteCallerFacts(
    endpointDetailEvidenceChunks,
    upstreamConstantNames,
  )
  const phpCallerChunks: RetrievedChunk[] = preliminaryUpstreamFacts.length === 0 && phpConstantNamesForExactRoutes.length === 0 && exactRoutes.length > 0
    ? await timeStage("php-caller-chunks", async () => {
        const routeSegments = exactRoutes.flatMap(r => r.split("/").filter(s => s.length > 3 && !/^v\d+$/.test(s)))
        if (routeSegments.length === 0) return []
        const bm25Hits = await bm25Search(routeSegments.join(" "), 16)
        if (bm25Hits.length === 0) return []
        try {
          const points = await qdrant.retrieve(config.collectionName, { ids: bm25Hits.map(r => r.id), with_payload: true })
          return points
            .map(p => ({ id: String(p.id), payload: p.payload as RetrievedPayload }))
            .filter(c => c.payload.content && c.payload.content.includes("Helper::requestAPI"))
        } catch (err) {
          console.error("BM25 PHP caller retrieve failed:", err instanceof Error ? err.message : err)
          return []
        }
      })
    : []
  if (preliminaryUpstreamFacts.length > 0) {
    dlog("stage", { name: "php-caller-chunks", status: "skipped", reason: "upstream-facts-already-present" })
  }
  const upstreamFacts = phpCallerChunks.length > 0
    ? extractUpstreamRouteCallerFacts(
        [...endpointDetailEvidenceChunks, ...phpCallerChunks],
        phpCallerChunks.flatMap(c =>
          [...(c.payload.content ?? "").matchAll(/\bHelper::requestAPI\s*\(\s*(?:[A-Z][A-Za-z0-9_]*::)?([A-Z][A-Z0-9_]+)/g)]
            .map(m => m[1] ?? "")
            .filter(Boolean)
        ),
      )
    : preliminaryUpstreamFacts
  const downstreamFacts = extractDownstreamRpcFacts(
    endpointDetailEvidenceChunks,
    exactRouteRepoNames,
  )
  const genericDownstreamFacts = extractGenericDownstreamRpcFacts(
    endpointDetailEvidenceChunks,
    exactRouteRepoNames,
    endpointRpcFuncNames,
  )
  const deterministicExactAnswer =
    exactComparison
      ? buildExactRouteComparisonAnswer(routeDefinitions, handlerFacts, downstreamFacts, chunks)
      : undefined
  const deterministicEndpointAnswer = exactEndpointInspection
    ? buildExactEndpointDetailAnswer(routeDefinitions, endpointFacts, genericDownstreamFacts, chunks, upstreamFacts)
    : undefined

  // In deep mode, skip ALL deterministic fast paths — let the LLM synthesize
  // from the full retrieved context for richer, more nuanced answers.
  fastPaths: {
    if (deepMode) break fastPaths

  if (deterministicExactAnswer || deterministicEndpointAnswer) {
    // Build source list from precise evidence chunks used in the answer.
    // selectEndpointSources picks at most 4: route definition, handler
    // implementation, upstream caller, downstream RPC/model — excluding
    // local-codebase-ai, unrelated doctor docs, and other handlers in the
    // same route file.
    const endpointDefinition = deterministicEndpointAnswer
      ? routeDefinitions.map(parseRouteDefinition).find(d => d !== undefined)
      : undefined
    const specificHandler = endpointDefinition?.handler.split(".").at(-1)
    const sourcePayloads = deterministicEndpointAnswer
      ? selectEndpointSources(
          [...exactChunks, ...exactDetailChunks, ...endpointExtraTermChunks, ...phpCallerChunks],
          endpointDefinition,
          specificHandler,
          endpointRpcFuncNames,
          exactRouteRepoNames,
        )
      : chunks
    const sourceChunks = compactPayloadSources(sourcePayloads, 16)

    dlog("early-return", { path: deterministicExactAnswer ? "exact-route-comparison" : "exact-endpoint-detail", totalMs: elapsedMs(mainStart), sources: sourceChunks.length })

    console.log("\nANSWER\n")
    console.log(localizeAnswer(deterministicExactAnswer ?? deterministicEndpointAnswer ?? "", question))

    console.log("\nSOURCES\n")

    for (const chunk of sourceChunks) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }

  if (chunks.length === 0) {
    console.warn("No chunks were retrieved. Try a broader question or remove repo/service filters.")
  }

  const exactSymbolAnswer =
    exactRoutes.length === 0 && exactTermChunks.length > 0
      ? buildExactSymbolAnswer(extractNamedSymbolsFromQuestion(question), mergeChunks([...exactTermChunks, ...exactTermDetailChunks], 24))
      : undefined

  if (exactSymbolAnswer) {
    const sourceChunks = compactPayloadSources(mergeChunks([...exactTermChunks, ...exactTermDetailChunks], 16).map(chunk => chunk.payload), 16)

    console.log("\nANSWER\n")
    console.log(localizeAnswer(exactSymbolAnswer, question))

    console.log("\nSOURCES\n")

    for (const chunk of sourceChunks) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }

  const platformTypeGlossaryAnswer = buildPlatformTypeGlossaryAnswer(chunks, question, localized)

  if (platformTypeGlossaryAnswer) {
    const sourceChunks = compactPayloadSources(chunks.filter(chunk => {
      return /platform_type|mt4DemoType|mt5DemoType|MetaTrader|MT4|MT5/i.test(chunk.content ?? "")
    }), 12)

    console.log("\nANSWER\n")
    console.log(platformTypeGlossaryAnswer)

    console.log("\nSOURCES\n")

    for (const chunk of sourceChunks) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }

  const accountTypeGlossaryAnswer = buildAccountTypeGlossaryAnswer(chunks, question, localized)

  if (accountTypeGlossaryAnswer) {
    const sourceChunks = compactPayloadSources(accountTypeRelevantSourceChunks(chunks, question), 12)

    console.log("\nANSWER\n")
    console.log(accountTypeGlossaryAnswer)

    console.log("\nSOURCES\n")

    for (const chunk of sourceChunks) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }

  if (questionAsksAboutAccountTypes(question)) {
    console.log("\nANSWER\n")
    console.log(buildAccountTypeNotFoundAnswer(question, localized))

    console.log("\nSOURCES\n")

    return
  }

  const medalMechanismAnswer = buildMedalMechanismAnswer(chunks, question)

  if (medalMechanismAnswer) {
    const sourceChunks = compactPayloadSources(chunks
      .filter(chunk => /dsc_channels_point_events|dsc_channels_point_medal_journal|dsc_channels_point_balance|dsc_channels_point_redeem|POINT_LEVELS|RANGE_MEDAL|prev_channel_medal|total_pips|last_qualify_id|qualify|redeemPointAsync|CalculatePointAndMedal20260531|current_month_vp|minimum_vp|average_monthly_vp|signal_settled|reset_channel/i.test(`${chunk.filePath ?? ""}\n${chunk.content ?? ""}`))
      , 12)

    console.log("\nANSWER\n")
    console.log(medalMechanismAnswer)

    console.log("\nSOURCES\n")

    for (const chunk of sourceChunks) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }

  const metaTraderPayloads = mergeChunks([...exactMetaTraderChunks, ...exactTermChunks, ...exactTermDetailChunks], 80).map(chunk => chunk.payload)
  const metaTraderTermAnswer = buildMetaTraderTermAnswer(metaTraderPayloads.length > 0 ? metaTraderPayloads : chunks, question)

  if (metaTraderTermAnswer) {
    const sourceChunks = compactPayloadSources((metaTraderPayloads.length > 0 ? metaTraderPayloads : chunks)
      .filter(chunk => /metatrader|platform_type|metaserver|serverplatform|tf_metatrader_platform_type|mrg_metatrader_platform_type|askap_metatrader_platform_type|volume_multiplier|akun metatrader/i.test(`${chunk.filePath ?? ""}\n${chunk.content ?? ""}`))
      .filter(chunk => !/devops-docs/i.test(chunk.filePath ?? ""))
      , 12)

    console.log("\nANSWER\n")
    console.log(metaTraderTermAnswer)

    console.log("\nSOURCES\n")

    for (const chunk of sourceChunks) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }

  const vocabularyAnswer = isDecisionIntentQuestion && decisionChunks.length > 0
    ? undefined
    : buildVocabularyAnswer(chunks, question, registryExpansion)

  if (vocabularyAnswer) {
    const sourceChunks = compactPayloadSources(chunks.filter(chunk => chunk.filePath?.startsWith("vocabulary://")), 12)

    console.log("\nANSWER\n")
    console.log(vocabularyAnswer)

    console.log("\nSOURCES\n")

    for (const chunk of sourceChunks) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }

  const commentRuleAnswer = buildCommentRuleAnswer(chunks, question)

  if (commentRuleAnswer) {
    console.log("\nANSWER\n")
    console.log(commentRuleAnswer)

    console.log("\nSOURCES\n")

    return
  }

  const documentationTimelineAnswer = buildDocumentationTimelineAnswer(chunks, question)

  if (documentationTimelineAnswer) {
    const sourceChunks = compactPayloadSources(chunks
      .filter(chunk => chunk.evidenceTypes?.includes("documentation"))
      .filter(chunk => /changelog|timeline|roadmap|history/i.test(chunk.filePath ?? ""))
      .filter(chunk => /isignal-docs/i.test(chunk.filePath ?? ""))
      , 12)

    console.log("\nANSWER\n")
    console.log(documentationTimelineAnswer)

    console.log("\nSOURCES\n")

    for (const chunk of sourceChunks) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }

  const minimumEquityEvidenceChunks = mergeChunks([
    ...exactMinimumEquityChunks,
    ...exactTermChunks,
    ...exactTermDetailChunks,
    ...answerChunks,
  ], 32).map(chunk => chunk.payload)
  const minimumEquityConfigAnswer = buildMinimumEquityConfigAnswer(minimumEquityEvidenceChunks.length > 0 ? minimumEquityEvidenceChunks : chunks, question)

  if (minimumEquityConfigAnswer) {
    const sourceChunks = compactPayloadSources((minimumEquityEvidenceChunks.length > 0 ? minimumEquityEvidenceChunks : chunks)
      .filter(chunk => /AUTO_COPY_MINIMUM_EQUITY|minimumEquity/i.test(`${chunk.filePath ?? ""}\n${chunk.content ?? ""}`))
      , 12)
    const answer = deepMode
      ? [
          localized("Investigation trace:", "Investigation trace:"),
          localized("- Step 1: mendeteksi pertanyaan minimum equity iSignal.", "- Step 1: detected an iSignal minimum equity question."),
          localized("- Step 2: mencari config code exact untuk AUTO_COPY_MINIMUM_EQUITY/minimumEquity.", "- Step 2: searched exact config code for AUTO_COPY_MINIMUM_EQUITY/minimumEquity."),
          localized("- Step 3: memakai evidence config terkonfirmasi sebelum retrieval dokumentasi yang lebih noisy.", "- Step 3: used confirmed config evidence before noisier documentation retrieval."),
          "",
          minimumEquityConfigAnswer,
        ].join("\n")
      : minimumEquityConfigAnswer

    console.log("\nANSWER\n")
    console.log(answer)

    console.log("\nSOURCES\n")

    for (const chunk of sourceChunks) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }

  const documentationEligibilityAnswer = buildDocumentationEligibilityAnswer(chunks, question)

  if (documentationEligibilityAnswer) {
    const sourceChunks = compactPayloadSources(chunks
      .filter(chunk => /isignal|auto copy|copy signal|bot copy|ois|subscription|bot|account|akun|equity|balance|mt4|mt5/i.test(`${chunk.filePath ?? ""}\n${chunk.content ?? ""}`))
      .filter(chunk => !isCronDocChunk(chunk))
      , 12)

    console.log("\nANSWER\n")
    console.log(documentationEligibilityAnswer)

    console.log("\nSOURCES\n")

    for (const chunk of sourceChunks) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }

  // In deep mode, skip the deterministic mermaid fast path — let the LLM synthesize
  // a richer answer using the diagram + surrounding retrieved context.
  const mermaidDiagramAnswer = !deepMode
    ? await buildMermaidDiagramAnswer(chunks, question)
    : undefined

  if (mermaidDiagramAnswer) {
    console.log("\nANSWER\n")
    console.log(mermaidDiagramAnswer.answer)

    console.log("\nSOURCES\n")

    for (const chunk of mermaidDiagramAnswer.sources) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }

  const registryAliasDefinitionAnswer = buildRegistryAliasDefinitionAnswer(question, registryExpansion)

  if (registryAliasDefinitionAnswer) {
    console.log("\nANSWER\n")
    console.log(registryAliasDefinitionAnswer)

    console.log("\nSOURCES\n")
    console.log("- config/services.json (local registry)")

    return
  }

  // Decision fast path must run before glossary/documentation paths — decision-intent
  // questions like "what is the rule about X" match questionAsksAboutGlossary() but
  // should be answered from approved decisions, not documentation summaries.
  const hasLearningRuleMatch = activeRules.some(r => question.toLowerCase().includes(r.trigger.toLowerCase()))
  const documentationGlossaryAnswer = (isDecisionIntentQuestion && decisionChunks.length > 0) || hasLearningRuleMatch
    ? undefined
    : await buildDocumentationGlossaryAnswer(chunks, question)

  if (documentationGlossaryAnswer) {
    const glossaryNotFoundAnswer = /Saya tidak menemukan definisi|I did not find an explicit/i.test(documentationGlossaryAnswer)
    const sourceChunks = glossaryNotFoundAnswer
      ? []
      : compactPayloadSources(documentationGlossarySourceChunks(chunks, question), 12)

    console.log("\nANSWER\n")
    console.log(documentationGlossaryAnswer)

    console.log("\nSOURCES\n")

    for (const chunk of sourceChunks) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }

  const doctorInventoryAnswer = questionAsksInventory(question)
    ? buildDoctorInventoryAnswer(chunks)
    : undefined
  const hasDoctorInventory = Boolean(doctorInventoryAnswer)

  // Direct Doctor inventory answer — no LLM needed for listing questions
  if (doctorInventoryAnswer) {
    console.log("\nANSWER\n")
    console.log(doctorInventoryAnswer.answer)
    console.log("\nSOURCES\n")
    for (const chunk of doctorInventoryAnswer.sources) {
      console.log(`- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`)
    }
    return
  }

  // Only use structural evidence answer when chunks actually contain structural signals
  // (routes, tables, queues, messages). Without those, it just emits a "missing anchor"
  // disclaimer that's worse than letting the LLM fallback synthesize from the raw context.
  const chunksHaveStructuralEvidence = chunks.some(c =>
    (c.routes?.length ?? 0) > 0 ||
    (c.dbTables?.length ?? 0) > 0 ||
    (c.queueNames?.length ?? 0) > 0 ||
    (c.messageNames?.length ?? 0) > 0 ||
    (c.exchangeNames?.length ?? 0) > 0,
  )
  const structuralEvidenceAnswer =
    !hasDoctorInventory &&
    exactRoutes.length === 0 &&
    chunksHaveStructuralEvidence &&
    (questionAsksAboutDatabase(question) || questionAsksAboutServicesOrFlow(question))
      ? buildStructuralEvidenceAnswer(chunks, question)
      : undefined

  if (structuralEvidenceAnswer) {
    console.log("\nANSWER\n")
    console.log(localizeAnswer(structuralEvidenceAnswer, question))

    console.log("\nSOURCES\n")

    for (const chunk of chunks) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }
  } // end fastPaths

  // Fast path for decision-intent questions when approved decisions are available.
  // Send only decision chunks with a focused prompt — avoids noise from code chunks
  // and works reliably with smaller models.
  if (isDecisionIntentQuestion && decisionChunks.length > 0) {
    // Pre-filter by keyword relevance — only send decisions that mention terms from the question.
    // Prevents the model from summarizing all decisions when only one is relevant.
    const questionTerms = unique([
      ...extractQuestionHints(question),
      ...extractQuestionTerms(question),
      ...extractConceptTokens(question),
    ], 24).map(t => t.toLowerCase()).filter(t => t.length >= 3)

    const scoredDecisions = decisionChunks.map(chunk => {
      const text = (chunk.payload.content ?? "").toLowerCase()
      const score = questionTerms.reduce((s, term) => s + (text.includes(term) ? 1 : 0), 0)
      return { chunk, score }
    })

    const relevantDecisions = scoredDecisions
      .filter(d => d.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(d => d.chunk)

    // Fall back to all decisions if none matched by keyword
    const decisionsToSend = relevantDecisions.length > 0 ? relevantDecisions : decisionChunks
    const decisionPayloads = decisionsToSend.map(chunk => chunk.payload)
    const decisionContext = decisionPayloads.map(p => p.content ?? "").join("\n\n---\n\n")
    const decisionPrompt = [
      `Question: ${question}`,
      "",
      "The following are approved architectural decisions from the team's decision log:",
      "",
      decisionContext,
      "",
      "Answer the question using only the decisions above.",
      "If no decision directly answers the question, say NOT_FOUND_IN_INDEXED_CODEBASE.",
      "Be concise. State the decision, the rationale if present, and which services are affected.",
      "Do not invent information not present in the decisions above.",
    ].join("\n")

    // Distinguish "LLM returned nothing" from "LLM call failed". Previously
    // both collapsed to "" via .catch(() => ""), making a down Ollama/network
    // error indistinguishable from "no matching decision" and silently falling
    // through to general retrieval. Now the failure is logged + flagged so it
    // is alertable, while still degrading safely.
    let decisionAnswer = ""
    let decisionLlmFailed = false
    try {
      decisionAnswer = await chat(decisionPrompt)
    } catch (err) {
      decisionLlmFailed = true
      const reason = err instanceof Error ? err.message : String(err)
      console.error(
        JSON.stringify({
          level: "warn",
          component: "decision-answer",
          event: "llm_call_failed",
          reason,
        }),
      )
    }

    if (decisionAnswer && !/^\s*$/.test(decisionAnswer)) {
      const sourceChunks = compactPayloadSources(decisionPayloads, 8)

      console.log("\nANSWER\n")
      console.log(decisionAnswer)
      console.log("\nSOURCES\n")
      for (const chunk of sourceChunks) {
        console.log(`- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`)
      }
      return
    }

    if (decisionLlmFailed) {
      // The decision LLM call failed (not merely empty) — record that we are
      // degrading to the general retrieval path instead of answering from decisions.
      console.error(
        JSON.stringify({
          level: "info",
          component: "decision-answer",
          event: "degrade_to_general_retrieval",
          reason: "decision LLM call failed",
        }),
      )
    }
  }

  const fallbackContextChunks = selectFallbackContextChunks(chunks, question)
  const context = fallbackContextChunks
    .map((chunk, index) => {
      return [
        `SOURCE ${index + 1}`,
        `repo: ${chunk.repoName}`,
        `projects: ${chunk.projectIds?.join(", ") ?? "unassigned"}`,
        `projectTagSources: ${chunk.projectTagSources?.join(", ") ?? ""}`,
        `branch: ${chunk.branchName}`,
        `commit: ${chunk.commitSha}`,
        `docLocale: ${chunk.docLocale ?? "default"}`,
        `serviceType: ${chunk.serviceType}`,
        `evidenceTypes: ${chunk.evidenceTypes?.join(", ") ?? "unknown"}`,
        `routes: ${chunk.routes?.join(", ") ?? ""}`,
        `symbols: ${chunk.symbols?.join(", ") ?? ""}`,
        `messageNames: ${chunk.messageNames?.join(", ") ?? ""}`,
        `queues: ${chunk.queueNames?.join(", ") ?? ""}`,
        `exchanges: ${chunk.exchangeNames?.join(", ") ?? ""}`,
        `dbTables: ${chunk.dbTables?.join(", ") ?? ""}`,
        `file: ${chunk.filePath}`,
        `lines: ${chunk.startLine}-${chunk.endLine}`,
        "```",
        chunk.content,
        "```",
      ].join("\n")
    })
    .join("\n\n")
  const evidenceInventory = buildEvidenceInventory(fallbackContextChunks, question)
  const graphFlowContext = buildGraphFlowContext(relationshipGraph, question, hints)
  const registryPromptContext = buildRegistryPromptContext(registryExpansion)
  const investigationTraceLines = deepInvestigation
    ? [
        "Investigation trace:",
        ...deepInvestigation.trace.map(item => `- ${item}`),
        "",
      ]
    : []

  const historyLines = history.length > 0
    ? [
        "Previous conversation:",
        ...history.map(h => `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`),
        "",
      ]
    : []

  const activeLearningRules = await loadActiveLearningRules()
  const learningRulesBlock = formatRulesForPrompt(activeLearningRules)

  const prompt = [
    ...historyLines,
    learningRulesBlock,
    `Question: ${question}`,
    `Answer language: ${answerLanguageLabel(question)}`,
    "",
    `Exact routes requested: ${exactRoutes.join(", ") || "none"}`,
    `Exact route matches found: ${exactChunks.length}`,
    `Handler/detail chunks found: ${exactDetailChunks.length}`,
    `Route handlers discovered: ${exactHandlerRefs.map(ref => ref.fullName).join(", ") || "none"}`,
    "",
    "Domain vocabulary hints:",
    registryPromptContext,
    "",
    "Extracted route definitions:",
    routeDefinitions.length > 0 ? routeDefinitions.join("\n\n") : "none",
    "",
    "Extracted handler facts:",
    handlerFacts.length > 0 ? handlerFacts.map(fact => `- ${fact}`).join("\n") : "none",
    "",
    "Evidence inventory:",
    evidenceInventory,
    "",
    "Cross-service graph evidence (from relationship index):",
    graphFlowContext,
    "",
    ...investigationTraceLines,
    "Relevant context:",
    context,
    "",
    "Answer requirements:",
    "- Answer in the same language as the user's question. If the question is in Bahasa Indonesia, answer in Bahasa Indonesia while keeping code identifiers unchanged.",
    "- Focus on answering the user's EXACT question. Do not describe unrelated features that happen to appear in the context. If the question asks about signal flow, describe signal flow — not the edit feature, even if edit docs are in the context.",
    "- For 'how does X work' questions, lead with code evidence (function names, SQL queries, cron jobs, queue operations). Use documentation only to provide context, not as the primary answer.",
    "- Synthesize a coherent answer that connects documentation and code evidence. Do not just list sources — explain how the pieces fit together.",
    "- For 'how does X work' questions, describe the end-to-end flow: entry points, processing steps, data flow, and output. Cite specific function names, SQL queries, queue operations, and config from the sources.",
    "- When code chunks are retrieved alongside docs, use the code to confirm, deepen, or correct what the docs say. Code is ground truth — if docs and code disagree, trust the code.",
    "- Quote specific function names, table names, and key lines from the source when explaining behavior. Do not paraphrase vaguely — point to the exact code.",
    "- Structure the answer with clear sections when the question is broad. Use markdown headers, not just bullet lists.",
    "- For cross-service flows, trace the path through services and explain each hop with evidence from the sources.",
    "- The cross-service graph evidence shows confirmed code-level connections between services (calls, handles, defines, touches table). Use these to trace cross-service flows and describe how services connect. These edges are confirmed by code analysis, not inferred.",
    "- Highlight design patterns, edge-case handling, and business rules visible in the code. These are insights the user cannot get from docs alone.",
    "- Anti-hallucination guardrail: every claim must trace back to a specific source chunk. If you cannot point to a function name, SQL query, config value, or doc line that supports a claim, do not make the claim.",
    "- Do not infer patterns, design decisions, or business rules that are not explicitly stated in the source code or documentation. Only describe what is directly visible in the code.",
    "- When connecting services or describing flows, only state connections that are explicitly shown in sources (e.g., a cron job calling a function, a SQL query referencing a table, a queue consumer). Do not infer connections from naming similarity or domain knowledge.",
    "- Answer from the context only.",
    "- Answer the user's exact question. If retrieved context is about a different topic, say NOT_FOUND_IN_INDEXED_CODEBASE for the requested topic instead of answering the different topic.",
    "- Domain vocabulary hints are synonyms for retrieval and disambiguation, not evidence. Do not present a hint as a fact unless it is supported by the source context.",
    "- Inline code comments are valid evidence when they directly state business rules, behavior, or consequences. If a comment clearly answers the user's question, quote it and cite the source. Do not require seeing the full implementation if the comment itself states the outcome.",
    "- For glossary/list questions, synthesize a concise glossary-style answer from all relevant source chunks. Include aliases, code constants, tables, routes, and rules only when they are visible in sources.",
    "- If the question asks for a list, return a list and cite the source lines for each group of facts.",
    "- If the question asks for a diagram, flowchart, Mermaid, or visual flow, include a fenced ```mermaid code block that uses only confirmed entities and edges from the context. Keep node labels short and include repo/service names when known.",
    "- If an indexed source contains a relevant Mermaid diagram, you may reuse or simplify that Mermaid diagram, but do not add unconfirmed edges.",
    "- If the question names exact routes or paths, prioritize sources whose content or route metadata exactly contains those paths.",
    "- Do not replace an exact route from the question with a different route unless explaining that the exact route was not found.",
    "- When comparing route definitions, compare method, alias, url, and handler exactly as written. Do not say handlers are the same if their names differ.",
    "- Do not say compared routes match exactly when their urls, aliases, or handlers differ.",
    "- Mention service/repo names, source file paths, and line ranges.",
    "- Mention branch names when they are present in source metadata.",
    "- Say NOT_FOUND_IN_INDEXED_CODEBASE only when NONE of the retrieved sources mention the user's topic. If any source, including inline comments, mentions the topic, answer from what it says even if the implementation uses variables or helper functions.",
    "- Treat the Evidence inventory as a whitelist for service, route, message, queue, exchange, and database table names.",
    "- Do not infer database table names from domain words. Only name tables that appear in metadata, SQL, or quoted source context.",
    "- Do not infer service involvement from class/client names alone. A service/repo is confirmed only when it appears in source metadata or an explicit source says it calls/handles the same route/message/function.",
    "- Use 'not confirmed in retrieved context' for gaps instead of hedging with likely, probably, might, or suggests.",
    "- If the evidence inventory says requested database/table evidence is not present, answer that the table impact is NOT_FOUND_IN_INDEXED_CODEBASE.",
    "- If the evidence inventory says requested service/flow evidence is not present, do not describe a flow; say what anchor was missing.",
    "- Prefer evidence from RabbitMQ handlers, API routes, cron jobs, database usage, and config files.",
    deepMode ? "- Deep investigation mode is enabled. Include a short 'Investigation trace' section before the final answer, summarizing which indexed evidence paths were followed. Keep it concise and do not expose hidden chain-of-thought." : undefined,
    deepMode ? "- In deep investigation mode, use the expanded evidence set to follow route -> handler -> RPC/message -> consumer -> database/config/docs when those links are present. Stop at NEED_MORE_EVIDENCE when the next link is missing." : undefined,
    "- Mention queue, routing key, exchange, and database table names when present.",
    "- If a route calls a symbol/message and another service consumes or handles the same symbol/message, explain that link as confirmed only when both sides appear in sources.",
    "- For general summary questions, only describe cross-service flow when the question asks about it or the context directly traces the flow through multiple services.",
    history.length > 0 ? "- This question may be a follow-up. Use the previous conversation to resolve pronouns like 'it', 'that', or 'the endpoint', but still ground your answer in the retrieved context above." : undefined,
  ].filter((line): line is string => typeof line === "string").join("\n")

  dlog("prompt-built", { promptChars: prompt.length, fallbackChunks: fallbackContextChunks.length })

  const answerStart = nowMs()
  let answer = await chat(prompt, deepMode ? config.deepMaxTokens : undefined)
  dlog("stage", { name: "answer-llm", ms: elapsedMs(answerStart), outChars: answer.length })

  // Quality gate: evaluate and retry if needed
  if (config.qualityRetryEnabled && fallbackContextChunks.length > 0) {
    const evalStart = nowMs()
    const evaluation = await evaluateAnswerQuality(question, answer, fallbackContextChunks)
    dlog("stage", { name: "quality-eval", ms: elapsedMs(evalStart), score: evaluation.score, threshold: config.qualityThreshold })
    await logQualityEvaluation(question, evaluation, false, answer)

    if (evaluation.score < config.qualityThreshold) {
      console.log(`\n⚠ Answer quality low (${evaluation.score.toFixed(2)}), retrying with refinement...\n`)

      const retryPrompt = `${prompt}\n\nPrevious answer had quality issues:\n${evaluation.issues.join("\n")}\n\nPlease improve the answer based on this feedback.`
      const retryStart = nowMs()
      answer = await chat(retryPrompt, deepMode ? config.deepMaxTokens : undefined)
      dlog("stage", { name: "answer-llm-retry", ms: elapsedMs(retryStart), outChars: answer.length })

      const retryEval = await evaluateAnswerQuality(question, answer, fallbackContextChunks)
      await logQualityEvaluation(question, retryEval, true, answer)
    }
  }

  const displayAnswer = /\bNOT_FOUND_IN_INDEXED_CODEBASE\b/.test(answer) && !/\bI do not have\b/i.test(answer)
    ? `I do not have enough indexed evidence for the requested topic.\n\n${answer}`
    : answer

  console.log("\nANSWER\n")
  console.log(localizeAnswer(displayAnswer, question))

  if (retrievalDegradation.bm25Unavailable) {
    console.log("\n[degraded] keyword (BM25) search was unavailable for this query — answer based on vector results only.")
  }

  console.log("\nSOURCES\n")

  // Build the complete set of chunks whose evidence was included in the prompt.
  // fallbackContextChunks is the main set, but the prompt also includes structured
  // facts (upstream/downstream/handler facts) extracted from endpointExtraTermChunks
  // and phpCallerChunks, which are retrieved AFTER the main chunk set and may not
  // be in fallbackContextChunks. Include them so source attribution is complete.
  const sourcePayloads = [...fallbackContextChunks]
  const seenKeys = new Set(
    fallbackContextChunks.map(c => `${c.repoName}:${c.filePath}:${c.startLine}-${c.endLine}`),
  )

  for (const chunk of [...endpointExtraTermChunks, ...phpCallerChunks]) {
    const p = chunk.payload
    const key = `${p.repoName}:${p.filePath}:${p.startLine}-${p.endLine}`
    if (!seenKeys.has(key)) {
      seenKeys.add(key)
      sourcePayloads.push(p)
    }
  }

  for (const chunk of sourcePayloads) {
    console.log(
      `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
    )
  }

  _askCompletedFull = true
  dlog("ask-complete", { totalMs: elapsedMs(mainStart), sources: sourcePayloads.length, bm25Degraded: retrievalDegradation.bm25Unavailable })
}

main()
  .then(() => {
    if (!_askCompletedFull) {
      dlog("ask-complete-early-return", { totalMs: elapsedMs(_askMainStart) })
    }
  })
  .catch(error => {
    dlog("ask-failed", { totalMs: elapsedMs(_askMainStart), error: error instanceof Error ? error.message : String(error) })
    console.error(error)
    process.exit(1)
  })

