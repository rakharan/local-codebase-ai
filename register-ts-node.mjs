import { register } from "node:module"
import { pathToFileURL } from "node:url"
import { config } from "dotenv"

config() // load .env before any module runs

register("ts-node/esm", pathToFileURL("./"))
