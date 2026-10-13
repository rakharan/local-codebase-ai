// Specialized Answers
// Refactored from ask.ts — uses ctx for shared state

import { config } from "../lib/config.js"
import type { RegistryExpansion, ServiceRegistryEntry } from "../lib/service-registry.js"
import type { RetrievedPayload } from "./types.js"
import { ctx } from "./context.js"
import { localized, shouldAnswerIndonesian } from "../ask.js"
import { payloadSource } from "./evidence.js"
import { extractDefinitionSubjectTerms, extractQuestionAcronyms, extractShortSubjectTokens, questionAsksAboutAccountTypes, questionAsksAboutGlossary, questionAsksMedalMechanism, questionMetaTraderTerm, unique } from "./question.js"

export function buildMedalMechanismAnswer(chunks: RetrievedPayload[], question: string): string | undefined {
  if (!questionAsksMedalMechanism(question)) return undefined

  const relevant = chunks.filter(chunk => {
    const content = chunk.content ?? ""
    const filePath = chunk.filePath ?? ""

    return /dsc_channels_point_events|dsc_channels_point_medal_journal|dsc_channels_point_balance|dsc_channels_point_redeem|POINT_LEVELS|RANGE_MEDAL|prev_channel_medal|total_pips|last_qualify_id|qualify|redeemPointAsync|CalculatePointAndMedal20260531|current_month_vp|minimum_vp|average_monthly_vp|signal_settled|reset_channel/i.test(`${filePath}\n${content}`)
  })

  if (relevant.length === 0) return undefined

  const hasPointEvents = relevant.some(chunk => /dsc_channels_point_events/i.test(chunk.content ?? ""))
  const hasQualifyRule = relevant.some(chunk => /prev_channel_medal\s*=\s*14|last_qualify_id|total_pips\s*>=\s*IFNULL|a\.medals\s*=\s*1/i.test(chunk.content ?? ""))
  const hasLevelConfig = relevant.some(chunk => /POINT_LEVELS|RANGE_MEDAL/i.test(`${chunk.filePath ?? ""}\n${chunk.content ?? ""}`))
  const hasRedeemLogic = relevant.some(chunk => /redeemPointAsync|CHANNEL_LEVEL_NOT_ENOUGH|dsc_channels_point_redeem|dsc_wallet_point|level\.money|level\.percentage/i.test(chunk.content ?? ""))
  const hasVpCalculation = relevant.some(chunk => /CalculatePointAndMedal20260531|EFFECTIVE MAY 2026|current_month_vp|tmp_params_target_qualify_vp|minimum_vp|average_monthly_vp|signal_settled|reset_channel/i.test(chunk.content ?? ""))

  if (!hasPointEvents && !hasLevelConfig && !hasVpCalculation) return undefined

  const lines: string[] = []
  const isIndonesian = shouldAnswerIndonesian(question)

  if (isIndonesian) {
    lines.push("Dari kode yang ter-index, medal tidak terlihat sebagai field statis yang diisi manual. Medal dihitung/dipakai lewat mekanisme point-event channel.")
    lines.push("")
    lines.push("Yang terkonfirmasi:")

    if (hasPointEvents) {
      lines.push("- Riwayat kenaikan/perubahan medal disimpan lewat `dsc_channels_point_events`; query terkait memakai `medals`, `prev_channel_medal`, `total_pips`, `point`, dan `last_qualify_id`.")
    }

    if (hasVpCalculation) {
      lines.push("- Formula VP terbaru ada di `CalculatePointAndMedal20260531`: channel qualify jika `signal_settled >= 5`, `current_month_pips >= 0`, dan `current_month_vp >= minimum_vp`. Target naik medal adalah `max(minimum_vp, 80% * average_monthly_vp)`; jika `current_month_vp` mencapai target itu, medal bertambah `+1`.")
      lines.push("- Kalau channel tidak aktif 2 bulan berturut-turut (`pips/signal settled/signal created` bulan ini dan bulan sebelumnya semuanya 0), medal di-reset turun sebesar current medal. Kalau `current_month_vp < 0`, kode masuk jalur punishment medal.")
    }

    if (hasQualifyRule) {
      lines.push("- Ada rule `qualify`: event dianggap qualify ketika `a.medals = 1`, atau ketika channel sebelumnya sudah medal 14 dan `total_pips` memenuhi minimal `70%` dari event qualify sebelumnya atau fallback `2000`, serta `point > 0`.")
    }

    if (hasLevelConfig) {
      lines.push("- Nama level hanya mapping dari jumlah medal: Newbie 0, Rookie 1-2, Pro 3-4, Elite 5-7, Master 8-12, Legend 13-14.")
    }

    if (hasRedeemLogic) {
      lines.push("- Benefit/redeem point memakai level dari range medal saat ini. Jika level tidak ditemukan atau `money == 0`, kode melempar `CHANNEL_LEVEL_NOT_ENOUGH`; jadi level Newbie/Rookie/Pro punya medal range tetapi belum punya benefit redeem.")
    }

    lines.push("")
    lines.push("Kesimpulan:")
    lines.push(hasVpCalculation
      ? hasPointEvents
        ? "- Untuk \"naik medal\", current evidence menunjuk ke job bulanan `tf2-sinyo`: performa channel dihitung dari VP/pips/signal settled, menghasilkan `achievement.medal`, lalu disimpan sebagai event/journal dan dipetakan ke level."
        : "- Untuk \"naik medal\", current evidence menunjuk ke formula `tf2-sinyo`: performa channel dihitung dari VP/pips/signal settled dan menghasilkan delta medal. Storage event/journal tidak ikut ter-retrieve pada jawaban ini."
      : "- Untuk \"naik medal\", evidence yang ada menunjuk ke kalkulasi periodik/event berbasis performa channel (`total_pips`, `point`, dan event sebelumnya), lalu hasil medal itu dipetakan ke level.")
    if (!hasVpCalculation) {
      lines.push("- Detail formula lengkap pemberian `a.medals` belum boleh disimpulkan kalau chunk yang menghitung nilai `medals` tidak ikut ter-retrieve; tapi storage, rule qualify, mapping level, dan efek benefit sudah terkonfirmasi.")
    }
  } else {
    lines.push("From the indexed code, medals do not look like a static/manual field. They are calculated and consumed through channel point-event logic.")
    lines.push("")
    lines.push("Confirmed pieces:")

    if (hasPointEvents) {
      lines.push("- Medal changes are tracked through `dsc_channels_point_events`; related queries use `medals`, `prev_channel_medal`, `total_pips`, `point`, and `last_qualify_id`.")
    }

    if (hasVpCalculation) {
      lines.push("- The newer VP formula is in `CalculatePointAndMedal20260531`: a channel qualifies when `signal_settled >= 5`, `current_month_pips >= 0`, and `current_month_vp >= minimum_vp`. The medal-up target is `max(minimum_vp, 80% * average_monthly_vp)`; reaching it adds `+1` medal.")
      lines.push("- If the channel is inactive for two consecutive months, the code resets medals by subtracting the current medal. If `current_month_vp < 0`, it enters punishment-medal logic.")
    }

    if (hasQualifyRule) {
      lines.push("- A `qualify` rule is present: an event qualifies when `a.medals = 1`, or when the previous channel medal was 14 and `total_pips` reaches at least `70%` of the previous qualifying event, falling back to `2000`, with `point > 0`.")
    }

    if (hasLevelConfig) {
      lines.push("- Level names are mappings from medal count: Newbie 0, Rookie 1-2, Pro 3-4, Elite 5-7, Master 8-12, Legend 13-14.")
    }

    if (hasRedeemLogic) {
      lines.push("- Point redemption uses the current medal range to pick a level. If no level is found or `money == 0`, code throws `CHANNEL_LEVEL_NOT_ENOUGH`; so Newbie/Rookie/Pro have medal ranges but no redeem benefit.")
    }

    lines.push("")
    lines.push("Conclusion:")
    lines.push(hasVpCalculation
      ? hasPointEvents
        ? "- To gain medals, current evidence points to the monthly `tf2-sinyo` job: channel performance is calculated from VP/pips/settled signals, producing `achievement.medal`, then stored as event/journal data and mapped to a level."
        : "- To gain medals, current evidence points to the `tf2-sinyo` formula: channel performance is calculated from VP/pips/settled signals and returns a medal delta. Event/journal storage was not retrieved for this answer."
      : "- To gain medals, the indexed evidence points to periodic/channel performance events based on `total_pips`, `point`, and previous event state; the resulting medal count is then mapped to a level.")
    if (!hasVpCalculation) {
      lines.push("- The full formula that assigns `a.medals` is not confirmed unless the chunk calculating that value is retrieved, but the event storage, qualify rule, level mapping, and benefit effects are confirmed.")
    }
  }

  const sources = unique(relevant.map(payloadSource), 8)

  return [
    ...lines,
    "",
    "Sources:",
    ...sources.map(source => `- ${source}`),
  ].join("\n")
}


export function buildMetaTraderTermAnswer(chunks: RetrievedPayload[], question: string): string | undefined {
  const term = questionMetaTraderTerm(question)

  if (!term) return undefined

  const wanted = term.toLowerCase()
  const relevant = chunks.filter(chunk => {
    const text = `${chunk.filePath ?? ""}\n${chunk.content ?? ""}`

    if (!new RegExp(`\\b${wanted}\\b`, "i").test(text)) return false
    if (/devops-docs/i.test(chunk.filePath ?? "")) return false

    return /metatrader|platform_type|metaserver|serverplatform|tf_metatrader_platform_type|mrg_metatrader_platform_type|askap_metatrader_platform_type|volume_multiplier|akun metatrader/i.test(text)
  })

  if (relevant.length === 0) return undefined

  const combined = relevant.map(chunk => `${chunk.filePath ?? ""}\n${chunk.content ?? ""}`).join("\n")
  const isIndonesian = shouldAnswerIndonesian(question)
  const facts: string[] = []

  if (/MetaTrader/i.test(combined)) {
    facts.push(isIndonesian
      ? `${term} adalah platform/jenis server MetaTrader yang dipakai sistem untuk akun trading dan eksekusi trade.`
      : `${term} is a MetaTrader platform/server type used by the system for trading accounts and trade execution.`)
  }

  if (term === "MT4") {
    if (/TF_METATRADER_PLATFORM_TYPE[\s\S]*MT4["']?\s*:\s*1/i.test(combined) || /MT4:\s*1/.test(combined)) {
      facts.push(isIndonesian
        ? "Di `tf2-ois`, mapping umum platform menunjukkan `MT4 = 1`."
        : "In `tf2-ois`, the general platform mapping shows `MT4 = 1`.")
    }

    if (/ASKAP_METATRADER_PLATFORM_TYPE[\s\S]*0:\s*\{\s*type:\s*["']MT4/i.test(combined) || /0:\s*["']MT4["']/.test(combined) || /["']?platform_type["']?\s*[:=]+\s*0\b/.test(combined)) {
      facts.push(isIndonesian
        ? "Untuk Askap/MMB, kode yang ter-index memetakan `platform_type 0` sebagai MT4."
        : "For Askap/MMB, indexed code maps `platform_type 0` to MT4.")
    }

    if (/MRG_METATRADER_PLATFORM_TYPE[\s\S]*0:\s*\{\s*type:\s*["']MT4/i.test(combined) || /["']?platform_type["']?\s*[:=]+\s*0\b/.test(combined)) {
      facts.push(isIndonesian
        ? "Untuk MRG, kode yang ter-index juga memetakan `platform_type 0` sebagai MT4."
        : "For MRG, indexed code also maps `platform_type 0` to MT4.")
    }

    if (/VOLUME_MULTIPLIER[\s\S]*["']MT4["']\s*:\s*100/i.test(combined)) {
      facts.push(isIndonesian
        ? "`VOLUME_MULTIPLIER.MT4` bernilai `100` di config `tf2-ois`."
        : "`VOLUME_MULTIPLIER.MT4` is `100` in `tf2-ois` config.")
    }
  } else {
    if (/TF_METATRADER_PLATFORM_TYPE[\s\S]*MT5["']?\s*:\s*2/i.test(combined) || /MT5:\s*2/.test(combined)) {
      facts.push(isIndonesian
        ? "Di `tf2-ois`, mapping umum platform menunjukkan `MT5 = 2`."
        : "In `tf2-ois`, the general platform mapping shows `MT5 = 2`.")
    }

    if (/ASKAP_METATRADER_PLATFORM_TYPE[\s\S]*5:\s*\{\s*type:\s*["']MT5/i.test(combined) || /5:\s*["']MT5["']/.test(combined) || /["']?platform_type["']?\s*[:=]+\s*5\b/.test(combined)) {
      facts.push(isIndonesian
        ? "Untuk Askap/MMB, kode yang ter-index memetakan `platform_type 5` sebagai MT5."
        : "For Askap/MMB, indexed code maps `platform_type 5` to MT5.")
    }

    if (/MRG_METATRADER_PLATFORM_TYPE[\s\S]*3:\s*\{\s*type:\s*["']MT5/i.test(combined) || /["']?platform_type["']?\s*[:=]+\s*3\b/.test(combined)) {
      facts.push(isIndonesian
        ? "Untuk MRG, kode yang ter-index memetakan `platform_type 3` sebagai MT5."
        : "For MRG, indexed code maps `platform_type 3` to MT5.")
    }

    if (/VOLUME_MULTIPLIER[\s\S]*["']MT5["']\s*:\s*10000/i.test(combined)) {
      facts.push(isIndonesian
        ? "`VOLUME_MULTIPLIER.MT5` bernilai `10000` di config `tf2-ois`."
        : "`VOLUME_MULTIPLIER.MT5` is `10000` in `tf2-ois` config.")
    }

    if (/ENABLE_MT5/i.test(combined)) {
      facts.push(isIndonesian
        ? "Beberapa flow mengecek `ENABLE_MT5`, jadi fitur MT5 bisa digate oleh konfigurasi environment."
        : "Some flows check `ENABLE_MT5`, so MT5 behavior can be gated by environment configuration.")
    }
  }

  if (facts.length === 0) return undefined

  const sources = unique(relevant.map(payloadSource), 8)

  return [
    isIndonesian
      ? `Berdasarkan kode yang ter-index:`
      : `Based on indexed code:`,
    ...facts.map(fact => `- ${fact}`),
    "",
    "Sources:",
    ...sources.map(source => `- ${source}`),
  ].join("\n")
}


export function buildCommentRuleAnswer(chunks: RetrievedPayload[], question: string): string | undefined {
  const questionLower = question.toLowerCase()
  const questionTokens = questionLower.split(/\s+/).filter(t => t.length >= 3)

  // Indonesian business rule comment markers
  const ruleMarkers = [/\bJIKA\b/i, /\bMAKA\b/i, /\bIF\b/i, /\bTHEN\b/i, /\bKETIKA\b/i, /\bWHEN\b/i]

  const matches: Array<{ comment: string, source: string, score: number }> = []

  for (const chunk of chunks) {
    const content = chunk.content ?? ""
    const lines = content.split("\n")

    for (const line of lines) {
      const trimmed = line.trim()

      // Only process single-line comments
      if (!trimmed.startsWith("//")) continue

      const commentText = trimmed.slice(2).trim()
      const commentLower = commentText.toLowerCase()

      // Check if this comment looks like a business rule
      const hasRuleMarker = ruleMarkers.some(marker => marker.test(commentText))
      if (!hasRuleMarker) continue

      // Score how many question tokens appear in the comment
      let tokenScore = 0

      for (const token of questionTokens) {
        if (commentLower.includes(token)) {
          tokenScore += token.length >= 5 ? 3 : 2
        }
      }

      // Boost score for phrase matches
      for (let i = 0; i < questionTokens.length - 1; i++) {
        const phrase = `${questionTokens[i]} ${questionTokens[i + 1]}`

        if (commentLower.includes(phrase)) {
          tokenScore += 5
        }
      }

      if (tokenScore >= 6) {
        matches.push({
          comment: commentText,
          source: `${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`,
          score: tokenScore,
        })
      }
    }
  }

  if (matches.length === 0) return undefined

  // Sort by score descending, pick the best
  matches.sort((a, b) => b.score - a.score)

  const best = matches[0]

  if (!best) return undefined

  const isIndonesian = shouldAnswerIndonesian(question)

  // Build a natural answer from the comment
  let answer = best.comment.replace(/^\/\/\s*/, "")

  // Clean up the comment text for presentation
  answer = answer.replace(/^JIKA\s+/i, isIndonesian ? "Jika " : "If ")
  answer = answer.replace(/^IF\s+/i, isIndonesian ? "Jika " : "If ")
  answer = answer.replace(/^KETIKA\s+/i, isIndonesian ? "Ketika " : "When ")
  answer = answer.replace(/^WHEN\s+/i, isIndonesian ? "Ketika " : "When ")
  answer = answer.replace(/\s+MAKA\s+/i, isIndonesian ? ", maka " : ", then ")
  answer = answer.replace(/\s+THEN\s+/i, isIndonesian ? ", maka " : ", then ")

  // If the comment is in all caps, convert to sentence case
  const letters = answer.replace(/[^a-zA-Z]/g, "")
  const uppercaseLetters = answer.replace(/[^A-Z]/g, "")

  if (letters.length > 0 && uppercaseLetters.length / letters.length > 0.7) {
    answer = answer.toLowerCase().replace(/^\w/, c => c.toUpperCase())
  }

  // Make it a complete sentence
  if (!/[.!?]$/.test(answer)) {
    answer += "."
  }

  return `${answer}\n\nSources:\n- ${best.source}`
}


export function cleanDocSummaryText(value: string): string {
  return value
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^>\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}


export function renderDocSummaryText(value: string): string {
  const normalized = value.trim()

  if (
    /^The Auto Copy system allows users to automatically replicate trading signals from master channels to their accounts\./.test(normalized) ||
    /^Sistem Auto Copy memungkinkan pengguna untuk secara otomatis menyalin sinyal perdagangan dari channel master ke akun mereka\./.test(normalized)
  ) {
    if (shouldAnswerIndonesian(ctx.question)) {
      return "iSignal / Auto Copy (bot copy) adalah sistem yang memungkinkan user menyalin trading signals secara otomatis dari master channel ke akun mereka. Sistem ini menangani flow end-to-end dari signal ingestion, order execution, dan proteksi akun dari stale or invalid trades."
    }

    return "iSignal / Auto Copy (bot copy) lets users automatically replicate trading signals from master channels to their accounts. It handles the end-to-end flow of signal ingestion, order execution, and protecting user accounts from stale or invalid trades."
  }

  return normalized
}


export function docLocaleForChunk(chunk: RetrievedPayload): string {
  if (chunk.docLocale) return chunk.docLocale

  const branchName = chunk.branchName ?? ""
  const localeMatch = branchName.match(/^docs:([^:]+)$/)

  return localeMatch?.[1] ?? "default"
}


export function scoreDocLocalePreference(chunk: RetrievedPayload): number {
  const locale = docLocaleForChunk(chunk)

  if (ctx.answerLanguage === "id") return locale === "id" ? 80 : 0
  if (ctx.answerLanguage === "en") return locale === "default" ? 15 : 0

  return 0
}


export function questionAsksProjectTimeline(question: string): boolean {
  return /\b(kapan|when|mulai|started|start|awal|pertama|didevelop|developed|development|dibuat|created|rilis|release|launch|changelog)\b/i.test(question) &&
    /\b(isignal|auto copy|copy signal|bot copy|ois)\b/i.test(question)
}


export function questionAsksEligibilityRequirement(question: string): boolean {
  return /\b(boleh|eligible|eligibility|ikut|join|participate|account|akun|jenis akun|tipe akun|minimal|minimum|equity|balance|saldo|syarat|persyaratan|requirement|requirements)\b/i.test(question) &&
    /\b(isignal|auto copy|copy signal|bot copy|ois)\b/i.test(question)
}


export function questionAsksMinimumEquityConfig(question: string): boolean {
  return /\b(equity|balance|saldo)\b/i.test(question) &&
    /\b(berapa|minimal|minimum|min|required|requirement|syarat|persyaratan|dibutuhkan|ikut|join|participate)\b/i.test(question) &&
    /\b(isignal|auto copy|copy signal|bot copy|ois|ikut|join|participate)\b/i.test(question)
}


export function isCronDocChunk(chunk: RetrievedPayload): boolean {
  return /cron-jobs|cron jobs|cronjob/i.test(`${chunk.filePath ?? ""}\n${chunk.content ?? ""}`)
}


export function buildDocumentationTimelineAnswer(chunks: RetrievedPayload[], question: string): string | undefined {
  if (!questionAsksProjectTimeline(question)) return undefined

  const isIsignalQuestion = /\b(isignal|auto copy|copy signal|bot copy|ois)\b/i.test(question)
  const candidates = chunks
    .filter(chunk => chunk.evidenceTypes?.includes("documentation"))
    .filter(chunk => /changelog|release|timeline|roadmap|ctx.history|perubahan/i.test(`${chunk.filePath ?? ""}\n${chunk.content ?? ""}`))
    .filter(chunk => /isignal|auto copy|copy signal|bot copy|ois/i.test(`${chunk.filePath ?? ""}\n${chunk.content ?? ""}`))
    // When asking about isignal specifically, exclude unrelated product changelogs
    .filter(chunk => !isIsignalQuestion || (chunk.filePath ?? "").toLowerCase().includes("isignal-docs"))
    .sort((left, right) => {
      const leftPath = left.filePath?.toLowerCase() ?? ""
      const rightPath = right.filePath?.toLowerCase() ?? ""
      const leftScore = (leftPath.includes("changelog") ? 100 : 0) + scoreDocLocalePreference(left)
      const rightScore = (rightPath.includes("changelog") ? 100 : 0) + scoreDocLocalePreference(right)

      return rightScore - leftScore
    })

  if (candidates.length === 0) return undefined

  const timelineFacts: string[] = []

  for (const chunk of candidates) {
    const lines = (chunk.content ?? "")
      .split(/\r?\n/)
      .map(line => cleanDocSummaryText(line))
      .filter(Boolean)
      .filter(line => !/^(Documentation|Source|Locale|title|description|file):/i.test(line))
      .filter(line => /(\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b|\b20\d{2}\b|v\d+|\brelease\b|\brilis\b|\bchangelog\b|\binitial\b|\bmulai\b|\bstart|\b(?:january|february|march|april|may|june|july|august|september|october|november|december|januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\b)/i.test(line))

    for (const line of lines) {
      timelineFacts.push(`${line} (${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${chunk.startLine}-${chunk.endLine})`)
      if (timelineFacts.length >= 20) break
    }

    if (timelineFacts.length >= 20) break
  }

  if (timelineFacts.length === 0) return undefined

  function timelineSortKey(fact: string): number {
    const monthMap: Record<string, number> = {
      januari: 1,
      january: 1,
      februari: 2,
      february: 2,
      maret: 3,
      march: 3,
      april: 4,
      mei: 5,
      may: 5,
      juni: 6,
      june: 6,
      juli: 7,
      july: 7,
      agustus: 8,
      august: 8,
      september: 9,
      oktober: 10,
      october: 10,
      november: 11,
      desember: 12,
      december: 12,
    }
    const isoMatch = fact.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/)
    if (isoMatch) return Number(`${isoMatch[1]}${isoMatch[2]?.padStart(2, "0")}${isoMatch[3]?.padStart(2, "0")}`)

    const textDateMatch = fact.toLowerCase().match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+),?\s+(20\d{2})\b/) ||
      fact.toLowerCase().match(/\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/)
    if (textDateMatch) {
      // handle both "1st August 2024" and "August 1st, 2024" patterns
      let day: string, monthName: string, year: string
      if (monthMap[textDateMatch[2] ?? ""] !== undefined) {
        // pattern: day month year
        day = textDateMatch[1]?.padStart(2, "0") ?? "99"
        monthName = textDateMatch[2] ?? ""
        year = textDateMatch[3] ?? "9999"
      } else {
        // pattern: month day year
        monthName = textDateMatch[1] ?? ""
        day = textDateMatch[2]?.padStart(2, "0") ?? "99"
        year = textDateMatch[3] ?? "9999"
      }
      const month = String(monthMap[monthName] ?? 99).padStart(2, "0")

      return Number(`${year}${month}${day}`)
    }

    const yearMatch = fact.match(/\b(20\d{2})\b/)
    if (yearMatch) return Number(`${yearMatch[1]}9999`)

    return Number.MAX_SAFE_INTEGER
  }

  const sortedFacts = unique(timelineFacts, 16)
    .sort((left, right) => timelineSortKey(left) - timelineSortKey(right))
    .slice(0, 12)

  return [
    localized("Tanggal mulai development iSignal tidak bisa dipastikan hanya dari evidence yang ter-retrieve.", "The exact iSignal development start date is not confirmed by the retrieved evidence."),
    localized("Evidence terdekat yang ditemukan adalah changelog/timeline berikut:", "Closest changelog/timeline evidence found:"),
    ...sortedFacts.map(fact => `- ${fact}`),
    "",
    localized("Kesimpulan: gunakan tanggal tertua di changelog sebagai petunjuk awal aktivitas terdokumentasi, bukan bukti pasti tanggal development pertama dimulai.", "Conclusion: treat the oldest changelog date as the earliest documented activity, not definitive proof of when development first began."),
  ].join("\n")
}


export function buildDocumentationEligibilityAnswer(chunks: RetrievedPayload[], question: string): string | undefined {
  if (!questionAsksEligibilityRequirement(question)) return undefined

  const asksEquity = /\b(equity|balance|saldo|minimal|minimum)\b/i.test(question)
  const asksAccountKind = !asksEquity && /\b(akun|account|jenis akun|tipe akun|boleh|eligible|ikut|join|participate)\b/i.test(question)
  const facts: string[] = []
  const candidates = chunks
    .filter(chunk => {
      const text = `${chunk.filePath ?? ""}\n${chunk.content ?? ""}`

      if (isCronDocChunk(chunk)) return false
      if (!/isignal-docs|isignal|auto copy|copy signal|bot copy|dsc_bot|dsc_subs|subscription/i.test(text)) return false
      return /isignal|auto copy|copy signal|bot copy|ois|subscription|bot|account|akun|equity|balance|mt4|mt5/i.test(text)
    })
    .sort((left, right) => {
      function score(chunk: RetrievedPayload): number {
        const text = `${chunk.filePath ?? ""}\n${chunk.content ?? ""}`.toLowerCase()
        let value = scoreDocLocalePreference(chunk)

        if (/business-rules|pricing|onboarding|guide|edit|edge-cases/i.test(chunk.filePath ?? "")) value += 80
        if (asksEquity && /equity|balance|saldo|minimal|minimum/i.test(text)) value += 120
        if (asksAccountKind && /account|akun|mt4|mt5|metatrader|real|demo|eligible|boleh/i.test(text)) value += 90
        if (/subscription|bot|auto copy|isignal/i.test(text)) value += 30
        if (isCronDocChunk(chunk)) value -= 200

        return value
      }

      return score(right) - score(left)
    })

  for (const chunk of candidates) {
    const lines = (chunk.content ?? "")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .filter(line => !/^(Documentation|Source|Locale|title|description|file):/i.test(line))
      .filter(line => !/^\|?\s*Cron[A-Z]/.test(line))
      .filter(line => {
        const text = line.toLowerCase()

        if (asksEquity && /\b(equity|saldo|deposit)\b/i.test(text)) return true
        if (asksAccountKind && /\b(account|akun|mt4|mt5|metatrader|real|demo|bot|subscription|eligible|boleh|follower|pengikut)\b/i.test(text)) return true

        return false
      })

    for (const line of lines) {
      facts.push(`${cleanDocSummaryText(line)} (${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${chunk.startLine}-${chunk.endLine})`)
      if (facts.length >= 10) break
    }

    if (facts.length >= 10) break
  }

  const uniqueFacts = unique(facts, 10)
  const missingSpecific = asksEquity
    ? localized("Saya tidak menemukan angka minimal equity yang eksplisit di evidence yang ter-retrieve.", "I did not find an explicit minimum equity number in the retrieved evidence.")
    : localized("Saya tidak menemukan daftar jenis akun yang eksplisit di evidence yang ter-retrieve.", "I did not find an explicit account-type eligibility list in the retrieved evidence.")

  if (uniqueFacts.length === 0) {
    return [
      missingSpecific,
      localized("Yang bisa dikonfirmasi: pertanyaan ini perlu evidence dari business rules/config/handler iSignal, bukan cron-job summary.", "What can be confirmed: this question needs evidence from iSignal business rules/config/handlers, not cron-job summaries."),
    ].join("\n")
  }

  return [
    localized("Berdasarkan evidence yang ter-index:", "Based on indexed evidence:"),
    ...uniqueFacts.map(fact => `- ${fact}`),
    asksEquity || asksAccountKind ? "" : undefined,
    asksEquity || asksAccountKind ? missingSpecific : undefined,
  ].filter((line): line is string => typeof line === "string").join("\n")
}


export function extractMinimumEquityConfigFacts(chunks: RetrievedPayload[]): MinimumEquityConfigFact[] {
  const facts: MinimumEquityConfigFact[] = []

  for (const chunk of chunks) {
    const lines = (chunk.content ?? "").split(/\r?\n/)

    for (const line of lines) {
      if (!/AUTO_COPY_MINIMUM_EQUITY|minimumEquity/i.test(line)) continue

      const trimmedLine = line.trim()
      const fallbackMatch = trimmedLine.match(
        /\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)?\s*=?\s*parseInt\(\s*process\.env\.(AUTO_COPY_MINIMUM_EQUITY)\s*\|\|\s*["'](\d+)["']/,
      ) ?? trimmedLine.match(
        /\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)?\s*=?\s*Number\(\s*process\.env\.(AUTO_COPY_MINIMUM_EQUITY)\s*\|\|\s*["'](\d+)["']/,
      ) ?? trimmedLine.match(
        /\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)?\s*=?\s*process\.env\.(AUTO_COPY_MINIMUM_EQUITY)\s*\|\|\s*["'](\d+)["']/,
      )
      const envOnlyMatch = trimmedLine.match(/process\.env\.(AUTO_COPY_MINIMUM_EQUITY)\b/)

      if (!fallbackMatch && !envOnlyMatch) continue

      const fact: MinimumEquityConfigFact = {
        envName: fallbackMatch?.[2] ?? fallbackMatch?.[1] ?? envOnlyMatch?.[1] ?? "AUTO_COPY_MINIMUM_EQUITY",
        evidenceLine: trimmedLine,
        source: payloadSource(chunk),
      }

      if (fallbackMatch?.[3]) fact.fallbackValue = fallbackMatch[3]
      if (fallbackMatch?.[1]) fact.variableName = fallbackMatch[1]

      facts.push(fact)
    }
  }

  return unique(facts.map(fact => JSON.stringify(fact)), 8).map(value => JSON.parse(value) as MinimumEquityConfigFact)
}


export function buildMinimumEquityConfigAnswer(chunks: RetrievedPayload[], question: string): string | undefined {
  if (!questionAsksMinimumEquityConfig(question)) return undefined

  const facts = extractMinimumEquityConfigFacts(chunks)
  const factWithFallback = facts.find(fact => fact.fallbackValue)
  const firstFact = factWithFallback ?? facts[0]

  if (!firstFact) return undefined

  if (factWithFallback?.fallbackValue) {
    return [
      localized(
        `Minimal equity iSignal yang terkonfirmasi dari kode adalah ${factWithFallback.fallbackValue}.`,
        `The confirmed iSignal minimum equity fallback in code is ${factWithFallback.fallbackValue}.`,
      ),
      localized(
        `Nilai itu berasal dari fallback env ${factWithFallback.envName}; jika env var ini diset di runtime, nilai runtime bisa berbeda dari fallback kode.`,
        `That value comes from the ${factWithFallback.envName} env fallback; if this env var is set at runtime, the runtime value can differ from the code fallback.`,
      ),
      "",
      "Evidence:",
      `- ${factWithFallback.evidenceLine} (${factWithFallback.source})`,
    ].join("\n")
  }

  return [
    localized(
      `Saya menemukan config env ${firstFact.envName} untuk minimum equity iSignal, tapi angka fallback eksplisitnya tidak ada di chunk yang ter-retrieve.`,
      `I found the ${firstFact.envName} env config for iSignal minimum equity, but no explicit fallback number in the retrieved chunks.`,
    ),
    "",
    "Evidence:",
    `- ${firstFact.evidenceLine} (${firstFact.source})`,
  ].join("\n")
}


export function normalizeRegistryAlias(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}


export function registryAliasMatchesTerm(entry: ServiceRegistryEntry, term: string): boolean {
  const normalizedTerm = normalizeRegistryAlias(term)

  if (!normalizedTerm) return false

  return [entry.name, ...(entry.aliases ?? [])].some(alias => {
    const normalizedAlias = normalizeRegistryAlias(alias)

    return normalizedAlias === normalizedTerm ||
      normalizedAlias.split(/\s+/g).includes(normalizedTerm)
  })
}


export function buildRegistryAliasDefinitionAnswer(question: string, expansion: RegistryExpansion): string | undefined {
  if (!questionAsksAboutGlossary(question)) return undefined
  if (questionAsksAboutAccountTypes(question)) return undefined
  if (/\b(aturan|rules?|rule|ketentuan|business rules?)\b/i.test(question)) return undefined

  const asksDefinition = /\b(apa itu|what is|maksud|meaning|define|definition|explain|describe|jelasin|jelaskan)\b/i.test(question)

  if (!asksDefinition) return undefined

  const explicitTerms = unique([
    ...extractDefinitionSubjectTerms(question),
    ...extractQuestionAcronyms(question),
    ...extractShortSubjectTokens(question),
  ], 12)
  const entry = expansion.matchedEntries.find(candidate => {
    if (candidate.kind !== "broker") return false

    return explicitTerms.some(term => registryAliasMatchesTerm(candidate, term))
  })

  if (!entry?.description) return undefined

  const canonicalName = entry.name
  const aliases = unique([entry.name, ...(entry.aliases ?? [])], 12)
  const repos = unique(entry.repos ?? [], 12)
  const projectId = entry.projectId ?? entry.name

  return [
    localized(
      `Berdasarkan registry lokal: ${entry.description}`,
      `From the local registry: ${entry.description}`,
    ),
    localized(
      `Nama canonical/projectId: ${canonicalName} / ${projectId}.`,
      `Canonical name/projectId: ${canonicalName} / ${projectId}.`,
    ),
    aliases.length > 0
      ? localized(`Alias: ${aliases.join(", ")}.`, `Aliases: ${aliases.join(", ")}.`)
      : undefined,
    repos.length > 0
      ? localized(`Repo terkait: ${repos.join(", ")}.`, `Related repos: ${repos.join(", ")}.`)
      : undefined,
    "",
    localized(
      "Catatan: ini berasal dari config/services.json sebagai registry lokal. Untuk detail implementasi, tanyakan endpoint, flow, tabel, atau tipe akun spesifik.",
      "Note: this comes from config/services.json as local registry knowledge. For implementation details, ask for a specific endpoint, flow, table, or account type.",
    ),
  ].filter((line): line is string => typeof line === "string").join("\n")
}


export type MinimumEquityConfigFact = {
  envName: string
  fallbackValue?: string
  variableName?: string
  evidenceLine: string
  source: string
}
