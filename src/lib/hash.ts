import crypto from "node:crypto"

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex")
}

export function uuidFromHash(hash: string): string {
  const hex = hash.slice(0, 32).padEnd(32, "0").split("")

  hex[12] = "5"
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16)

  return [
    hex.slice(0, 8).join(""),
    hex.slice(8, 12).join(""),
    hex.slice(12, 16).join(""),
    hex.slice(16, 20).join(""),
    hex.slice(20, 32).join(""),
  ].join("-")
}
