// Centralized dotenv loader — import this at the top of every entry point.
// Replaces the old register-ts-node.mjs dotenv loading that was lost when switching to tsx.
import { config as dotenvConfig } from "dotenv"
dotenvConfig()
