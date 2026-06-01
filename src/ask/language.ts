import { detectPreferredLanguage } from "../lib/ollama.js"
import type { AnswerLanguage } from "../lib/ollama.js"

export function heuristicAnswerLanguage(question: string): AnswerLanguage {
  if (/\b(apa|apakah|bagaimana|gimana|kenapa|mengapa|jelasin|jelaskan|terangkan|berikan|daftar|tipe|jenis|akun|aturan|beda|bedanya|perbedaan|yang|dan|atau|dari|untuk|dengan|di|ke|validasi|validasinya|returnnya|servis|layanan|tabel|database|alur|endpointnya|bodynya)\b/i.test(question)) {
    return "id"
  }

  if (/\b(what|which|when|where|why|how|explain|describe|show|give|list|difference|return|validation|endpoint|service|database|table|flow)\b/i.test(question)) {
    return "en"
  }

  return "unknown"
}

export async function detectAnswerLanguage(question: string): Promise<AnswerLanguage> {
  const heuristic = heuristicAnswerLanguage(question)
  const detected = await detectPreferredLanguage(question)

  if (detected === "unknown") return heuristic
  if (heuristic !== "unknown" && heuristic !== detected) return heuristic

  return detected
}

export function shouldAnswerIndonesian(question: string, answerLanguage: AnswerLanguage): boolean {
  return answerLanguage === "id" || (answerLanguage === "unknown" && heuristicAnswerLanguage(question) === "id")
}

export function answerLanguageLabel(question: string, answerLanguage: AnswerLanguage): string {
  const language = answerLanguage === "unknown" ? heuristicAnswerLanguage(question) : answerLanguage

  if (language === "id") return "Indonesian/Bahasa Indonesia"
  if (language === "en") return "English"

  return "same language as the question"
}

export function localized(question: string, answerLanguage: AnswerLanguage, id: string, en: string): string {
  return shouldAnswerIndonesian(question, answerLanguage) ? id : en
}

export function localizeAnswer(answer: string, question: string, answerLanguage: AnswerLanguage): string {
  if (!shouldAnswerIndonesian(question, answerLanguage)) return answer

  const replacements: Array<[RegExp, string]> = [
    [/Endpoint definition found in/g, "Definisi endpoint ditemukan di"],
    [/Exact symbol evidence found for:/g, "Evidence symbol persis ditemukan untuk:"],
    [/Graph flow found from relationship index:/g, "Flow graph ditemukan dari relationship index:"],
    [/Confirmed path:/g, "Path yang terkonfirmasi:"],
    [/Matching paths:/g, "Path yang cocok:"],
    [/Entry:/g, "Entry:"],
    [/Endpoint handlers:/g, "Handler endpoint:"],
    [/Handler behavior:/g, "Behavior handler:"],
    [/RPC calls from handlers:/g, "Call RPC dari handler:"],
    [/External calls from handlers:/g, "Call eksternal dari handler:"],
    [/Downstream handlers for external\/API funcs:/g, "Handler downstream untuk func API eksternal:"],
    [/Downstream handler behavior:/g, "Behavior handler downstream:"],
    [/Model\/symbol calls inside downstream handlers:/g, "Call model/symbol di dalam handler downstream:"],
    [/Model\/symbol behavior:/g, "Behavior model/symbol:"],
    [/Downstream RPC symbols:/g, "Symbol RPC downstream:"],
    [/Database\/table touches near downstream symbols:/g, "Touch database/tabel di sekitar symbol downstream:"],
    [/Confirmed facts:/g, "Fakta yang terkonfirmasi:"],
    [/referenced by route in/g, "direferensikan oleh route di"],
    [/referenced by route block in/g, "direferensikan oleh block route di"],
    [/Services\/repos involved:/g, "Service/repo yang terlibat:"],
    [/Upstream callers:/g, "Caller upstream:"],
    [/Request body:/g, "Request body:"],
    [/API-layer validation and payload behavior:/g, "Validasi layer API dan perilaku payload:"],
    [/Database\/table effects:/g, "Efek database/tabel:"],
    [/Downstream RPC\/model behavior:/g, "Perilaku RPC/model downstream:"],
    [/Return:/g, "Return:"],
    [/Evidence:/g, "Evidence:"],
    [/What is still missing:/g, "Yang masih belum ada:"],
    [/Retrieved repos\/services with matching evidence:/g, "Repo/service yang ditemukan dari evidence:"],
    [/Confirmed routes in retrieved evidence:/g, "Route yang terkonfirmasi di evidence:"],
    [/Confirmed message\/queue evidence:/g, "Evidence message/queue yang terkonfirmasi:"],
    [/Database\/table evidence:/g, "Evidence database/tabel:"],
    [/Table evidence sources:/g, "Source evidence tabel:"],
    [/Retrieved source set:/g, "Source yang ter-retrieve:"],
    [/The important difference is in the handler behavior, not only the URL version\./g, "Perbedaan pentingnya ada di behavior handler, bukan hanya versi URL."],
    [/Behavioral differences:/g, "Perbedaan behavior:"],
    [/Return behavior:/g, "Behavior return:"],
    [/Handler details found:/g, "Detail handler yang ditemukan:"],
    [/Downstream RPC details found:/g, "Detail RPC downstream yang ditemukan:"],
    [/method:/g, "method:"],
    [/alias:/g, "alias:"],
    [/handler:/g, "handler:"],
    [/body fields:/g, "field body:"],
    [/rpc func values:/g, "nilai func RPC:"],
    [/external API func values:/g, "nilai func API eksternal:"],
    [/required fields\/checks:/g, "field/check wajib:"],
    [/calls:/g, "memanggil:"],
    [/tables:/g, "tabel:"],
    [/validation\/auth:/g, "validasi/auth:"],
    [/extra payload:/g, "payload tambahan:"],
    [/return:/g, "return:"],
    [/verifies JWT/g, "memverifikasi JWT"],
    [/checks JWT user-agent against request user-agent/g, "mengecek user-agent JWT terhadap user-agent request"],
    [/requires authenticated userid >= 1/g, "mewajibkan userid terautentikasi >= 1"],
    [/throws on request\.validationError/g, "throw jika ada request.validationError"],
    [/looks up mapped MRG account for userid/g, "mencari mapping akun MRG untuk userid"],
    [/throws MRG_ACCOUNT_NOT_FOUND when mapped MRG account is missing/g, "throw MRG_ACCOUNT_NOT_FOUND jika mapping akun MRG tidak ada"],
    [/adds user_id from mapped mrguser\.mrgid/g, "menambahkan user_id dari mrguser.mrgid yang sudah ter-mapping"],
    [/adds ip from x-forwarded-for or remoteAddress/g, "menambahkan ip dari x-forwarded-for atau remoteAddress"],
    [/adds browser from user-agent header/g, "menambahkan browser dari header user-agent"],
    [/calls RPC func:/g, "memanggil func RPC:"],
    [/calls MRGAccountRpc\.send/g, "memanggil MRGAccountRpc.send"],
    [/uses Joi schema validation/g, "menggunakan validasi schema Joi"],
    [/requires positive integer login/g, "mewajibkan login integer positif"],
    [/requires nominal integer from 1 to 9999999/g, "mewajibkan nominal integer dari 1 sampai 9999999"],
    [/requires metaserver_id 1 or 2/g, "mewajibkan metaserver_id 1 atau 2"],
    [/requires integer user_id/g, "mewajibkan user_id integer"],
    [/checks users_demoid for matching demo account/g, "mengecek users_demoid untuk akun demo yang cocok"],
    [/checks users_demoid/g, "mengecek users_demoid"],
    [/writes to deposit_demo/g, "menulis ke deposit_demo"],
    [/creates deposit_demo row with status 0/g, "membuat row deposit_demo dengan status 0"],
    [/calls demo balance RPC/g, "memanggil RPC balance demo"],
    [/uses MT4 demo balance flow when metaserver_id is 1/g, "memakai flow balance demo MT4 ketika metaserver_id = 1"],
    [/uses MT5 demo balance flow when metaserver_id is 2/g, "memakai flow balance demo MT5 ketika metaserver_id = 2"],
    [/returns true on success/g, "mengembalikan true saat sukses"],
    [/marks deposit_demo status 1 on success/g, "menandai deposit_demo status 1 saat sukses"],
    [/marks deposit_demo status 2 on failure/g, "menandai deposit_demo status 2 saat gagal"],
    [/delegates to demoModel\.SubmitDepositDemo/g, "mendelegasikan ke demoModel.SubmitDepositDemo"],
    [/initial result is/g, "nilai awal result adalah"],
    [/sets result\.message from RPC res\.message/g, "mengisi result.message dari RPC res.message"],
    [/returns result/g, "mengembalikan result"],
    [/downstream model returns true on success before the API returns RPC res\.message/g, "model downstream mengembalikan true saat sukses sebelum API mengembalikan RPC res.message"],
    [/before the API returns RPC res\.message/g, "sebelum API mengembalikan RPC res.message"],
    [/I do not have an exact route\/function anchor for this question, so this is an evidence-only retrieval summary, not a confirmed end-to-end flow\./g, "Saya tidak punya anchor route/function yang persis untuk pertanyaan ini, jadi ini hanya ringkasan retrieval berbasis evidence, bukan flow end-to-end yang terkonfirmasi."],
    [/An exact endpoint, function name, queue name, or RPC func is needed to confirm a full service-to-service flow\./g, "Perlu endpoint, nama function, queue name, atau func RPC yang persis untuk mengonfirmasi flow service-to-service penuh."],
    [/Retrieved repos\/files alone are not proof that every listed repo participates in the same runtime path\./g, "Repo/file yang ter-retrieve saja belum membuktikan semua repo tersebut ikut dalam runtime path yang sama."],
    [/This answer only uses chunks that exactly mention the named symbol plus nearby chunks\./g, "Jawaban ini hanya memakai chunk yang menyebut symbol tersebut secara persis plus chunk di sekitarnya."],
    [/If you need the full runtime flow, ask with the endpoint path, queue name, or RPC func and include what detail you want\./g, "Kalau butuh runtime flow penuh, tanyakan dengan path endpoint, queue name, atau func RPC dan sertakan detail yang kamu mau."],
    [/No upstream caller was extracted from the retrieved context\./g, "Tidak ada caller upstream yang berhasil diekstrak dari context yang ter-retrieve."],
    [/No database\/table effect was extracted\./g, "Tidak ada efek database\/tabel yang berhasil diekstrak."],
  ]

  return replacements.reduce((localized, [pattern, replacement]) => localized.replace(pattern, replacement), answer)
}
