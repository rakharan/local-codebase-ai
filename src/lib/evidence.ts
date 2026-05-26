export type EvidenceType =
  | "api_route"
  | "controller"
  | "rabbitmq_publisher"
  | "rabbitmq_consumer"
  | "typeorm_entity"
  | "db_model"
  | "migration"
  | "raw_sql"
  | "env_config"
  | "docker_config"
  | "ci_config"
  | "cron_job"
  | "shell_script"
  | "test"
  | "documentation"
  | "unknown"

function includesAny(input: string, patterns: string[]): boolean {
  return patterns.some(pattern => input.includes(pattern))
}

export function inferEvidenceTypes(filePath: string, content: string): EvidenceType[] {
  const path = filePath.toLowerCase()
  const text = content.toLowerCase()
  const evidence = new Set<EvidenceType>()

  if (path.endsWith(".md")) evidence.add("documentation")
  if (
    path.includes("test") ||
    path.includes("__tests__") ||
    path.endsWith(".spec.ts") ||
    path.endsWith("_test.go") ||
    path.includes("phpunit") ||
    includesAny(text, ["describe(", "it(", "test(", "assert.", "assert::"])
  ) {
    evidence.add("test")
  }
  if (
    path.includes("dockerfile") ||
    path.includes("docker-compose") ||
    path.includes("compose.yml") ||
    path.includes("compose.yaml")
  ) {
    evidence.add("docker_config")
  }
  if (path.includes("jenkinsfile") || path.includes(".github/workflows") || path.includes(".gitlab-ci")) {
    evidence.add("ci_config")
  }
  if (
    path.endsWith(".env.example") ||
    path.includes("config") ||
    includesAny(text, ["process.env", "dotenv", "getenv(", "$_env", "os.getenv", "viper.", "std::getenv"])
  ) {
    evidence.add("env_config")
  }
  if (path.endsWith(".sql") || includesAny(text, ["select ", "insert into", "update ", "delete from"])) {
    evidence.add("raw_sql")
  }
  if (path.includes("migration")) evidence.add("migration")
  if (includesAny(text, ["schema::create", "schema::table", "create table", "alter table"])) {
    evidence.add("migration")
  }
  if (includesAny(text, ["@entity", "typeorm", "extends baseentity"])) evidence.add("typeorm_entity")
  if (
    path.includes("model") ||
    path.includes("entity") ||
    includesAny(text, ["gorm.model", "db.Model", "extends model", "mysqli", "pdo(", "sqlx.", "database/sql"])
  ) {
    evidence.add("db_model")
  }
  if (
    includesAny(text, ["@controller", "controller(", "class ", "func "]) &&
    (path.includes("controller") || path.includes("handler") || path.includes("action"))
  ) {
    evidence.add("controller")
  }
  if (
    includesAny(text, [
      "@get(",
      "@post(",
      "@put(",
      "@patch(",
      "@delete(",
      "router.",
      "app.get",
      "app.post",
      "$_server['request_method']",
      "$_server[\"request_method\"]",
      "$_get",
      "$_post",
      "http.handlefunc",
      "http.handle(",
      ".get(",
      ".post(",
      ".put(",
      ".delete(",
    ])
  ) {
    evidence.add("api_route")
  }
  if (
    includesAny(text, [
      "amqp",
      "rabbitmq",
      "routingkey",
      "routing_key",
      "exchange",
      "queue",
      "basic_publish",
      "basic_consume",
      "queuedeclare",
      "exchange_declare",
    ])
  ) {
    if (
      includesAny(text, [
        "publish",
        "sendtoqueue",
        "emit(",
        "basic_publish",
        ".publish(",
        "channel.publish",
      ])
    ) {
      evidence.add("rabbitmq_publisher")
    }
    if (
      includesAny(text, [
        "consume",
        "@eventpattern",
        "@messagepattern",
        "subscribe",
        "basic_consume",
        ".consume(",
        "channel.consume",
      ])
    ) {
      evidence.add("rabbitmq_consumer")
    }
  }
  if (
    includesAny(text, ["@cron", "cron.schedule", "schedulejob", "setinterval", "crontab", "cronexpr"]) ||
    path.includes("cron") ||
    path.includes("scheduled")
  ) {
    evidence.add("cron_job")
  }
  if (path.endsWith(".sh") || path.endsWith(".bash") || path.endsWith(".zsh") || path.endsWith(".ps1")) {
    evidence.add("shell_script")
  }

  return evidence.size > 0 ? [...evidence] : ["unknown"]
}
