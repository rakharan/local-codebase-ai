# Requirements Document

## Introduction

Repo Doctor is a deterministic documentation generator that lives inside the Local Codebase AI project under `src/doctor/`. It scans a target repository read-only and produces a fixed set of Markdown documents that describe the repository's services, environment variables, HTTP API surface, RabbitMQ usage, database usage, and overall architecture.

Unlike the rest of Local Codebase AI, Repo Doctor performs no embedding, no retrieval, and no language-model inference. It relies exclusively on static analysis, regular expressions, and lightweight parsing so that its output is fully reproducible from the source code alone. Every extracted fact is attributed to a source file path when one is available and is labeled with a confidence level so that readers can judge reliability.

Repo Doctor is invoked through a CLI command (`npm run doctor -- <root-folder> --output <output-folder>`) and reuses existing shared infrastructure (the repository scanner, ignore rules, file utilities, and relationship extraction utilities) while avoiding any dependency on Ollama, Qdrant, RAG answer generation, or embedding modules.

## Glossary

- **Repo_Doctor**: The deterministic documentation generator subsystem implemented under `src/doctor/`.
- **Doctor_CLI**: The command-line entry point exposed as `npm run doctor` that orchestrates a Repo Doctor run.
- **Target_Repository**: The repository located at the user-supplied root folder that Repo Doctor scans read-only.
- **Output_Directory**: The user-supplied folder where Repo Doctor writes generated Markdown files.
- **Scanner**: The existing shared module (`readRepoFiles` in `src/lib/files.ts`) that enumerates eligible source files and applies ignore rules.
- **Ignore_Rules**: The existing default ignore patterns plus `.gitignore` rules applied by the Scanner to exclude files such as `node_modules`, build output, binaries, and secret files.
- **Relationship_Extractor**: The existing shared module (`inferRelationshipHints` in `src/lib/relationships.ts`) that extracts routes, symbols, message names, queue names, exchange names, and database table names from file content.
- **Extractor**: A pure Repo Doctor function that accepts source content as strings and returns structured facts without performing filesystem access.
- **Extracted_Fact**: A unit of information produced by an Extractor, including a value, an optional source file path, and a confidence label.
- **Confidence_Label**: One of the values `high`, `medium`, or `low` attached to each Extracted_Fact.
- **Markdown_Generator**: A pure Repo Doctor function that converts structured facts into Markdown document content.
- **Generated_Document**: One of the fixed output Markdown files: `overview.md`, `services.md`, `env.md`, `api.md`, `rabbitmq.md`, `database.md`, `architecture.md`.

## Requirements

### Requirement 1: CLI Invocation and Argument Handling

**User Story:** As a developer, I want to run Repo Doctor with a root folder and an output folder, so that I can generate documentation for a target repository from the command line.

#### Acceptance Criteria

1. THE Doctor_CLI SHALL accept a positional root-folder argument identifying the Target_Repository.
2. THE Doctor_CLI SHALL accept an `--output` option identifying the Output_Directory.
3. WHEN the Doctor_CLI is invoked with a valid root-folder argument and a valid `--output` option, THE Repo_Doctor SHALL scan the Target_Repository and write all Generated_Documents to the Output_Directory.
4. IF the root-folder argument is missing, THEN THE Doctor_CLI SHALL report a descriptive error identifying the missing root-folder argument and SHALL exit with a non-zero status code.
5. IF the `--output` option is missing, THEN THE Doctor_CLI SHALL report a descriptive error identifying the missing output option and SHALL exit with a non-zero status code.
6. IF the root-folder argument refers to a path that does not exist or is not a directory, THEN THE Doctor_CLI SHALL report a descriptive error identifying the invalid path and SHALL exit with a non-zero status code.
7. WHEN the Output_Directory does not exist, THE Repo_Doctor SHALL create the Output_Directory before writing Generated_Documents.

### Requirement 2: Read-Only Scanning of the Target Repository

**User Story:** As a developer, I want Repo Doctor to never modify the repository it scans, so that documentation generation is safe to run against any codebase.

#### Acceptance Criteria

1. WHILE scanning the Target_Repository, THE Repo_Doctor SHALL read files from the Target_Repository without creating, modifying, or deleting any file inside the Target_Repository.
2. THE Repo_Doctor SHALL write all output exclusively to the Output_Directory.
3. WHERE the Output_Directory resides inside the Target_Repository, THE Doctor_CLI SHALL report a descriptive error and SHALL exit with a non-zero status code before writing any Generated_Document.
4. THE Repo_Doctor SHALL enumerate Target_Repository files using the Scanner so that Ignore_Rules are applied.
5. WHILE enumerating files, THE Repo_Doctor SHALL exclude files matched by the Ignore_Rules from extraction.

### Requirement 3: No LLM, Embedding, or Vector Dependencies

**User Story:** As a maintainer, I want Repo Doctor to run without Ollama, Qdrant, or external LLM APIs, so that documentation can be produced deterministically and offline.

#### Acceptance Criteria

1. THE Repo_Doctor SHALL produce all Generated_Documents using only static analysis, regular expressions, and lightweight parsing.
2. THE Repo_Doctor SHALL complete a documentation run without sending any network request to an Ollama service.
3. THE Repo_Doctor SHALL complete a documentation run without sending any network request to a Qdrant service.
4. THE Repo_Doctor SHALL complete a documentation run without sending any network request to an external language-model API.
5. THE Repo_Doctor modules SHALL import only the Scanner, Ignore_Rules, file utilities, and Relationship_Extractor from existing shared modules, and SHALL NOT import Ollama clients, Qdrant clients, RAG answer generation modules, or embedding modules.

### Requirement 4: Deterministic and Reproducible Output

**User Story:** As a developer, I want repeated runs against unchanged source code to produce identical documentation, so that I can rely on the output and track changes meaningfully.

#### Acceptance Criteria

1. WHEN the Repo_Doctor runs twice against an unchanged Target_Repository, THE Repo_Doctor SHALL produce byte-identical content for each Generated_Document across both runs.
2. WHERE multiple Extracted_Facts are listed within a Generated_Document, THE Markdown_Generator SHALL order the Extracted_Facts using a stable deterministic ordering that does not depend on filesystem enumeration order.
3. THE Repo_Doctor SHALL derive all Generated_Document content from the Target_Repository source files and SHALL NOT include timestamps, random values, or host-specific paths in Generated_Documents.

### Requirement 5: Fact Attribution and Confidence Labeling

**User Story:** As a reader of the documentation, I want each extracted fact to cite its source file and a confidence level, so that I can verify and trust the information.

#### Acceptance Criteria

1. WHERE an Extracted_Fact is derived from a single identifiable source file, THE Extractor SHALL attach the source file path of that file to the Extracted_Fact.
2. THE Extractor SHALL attach a Confidence_Label of `high`, `medium`, or `low` to every Extracted_Fact.
3. THE Markdown_Generator SHALL render the source file path for each Extracted_Fact that has one in the corresponding Generated_Document.
4. THE Markdown_Generator SHALL render the Confidence_Label for each Extracted_Fact in the corresponding Generated_Document.
5. WHERE an Extracted_Fact cannot be attributed to a specific source file, THE Markdown_Generator SHALL render the Extracted_Fact without a source file path and SHALL retain the Confidence_Label.

### Requirement 6: Package Metadata and Service Extraction

**User Story:** As a developer, I want Repo Doctor to extract project and service metadata from package manifests, so that the generated services documentation reflects the repository's components.

#### Acceptance Criteria

1. WHEN a `package.json` file is present in the Target_Repository, THE Extractor SHALL extract the package name, version, and declared scripts as Extracted_Facts.
2. WHEN a `package.json` file declares dependencies, THE Extractor SHALL extract the dependency names and version ranges as Extracted_Facts.
3. THE Markdown_Generator SHALL write the extracted package metadata and service information to `services.md`.
4. IF a `package.json` file contains content that cannot be parsed as valid JSON, THEN THE Extractor SHALL record a `low` Confidence_Label parse-failure Extracted_Fact identifying the source file path and SHALL continue processing remaining files.
5. THE package metadata Extractor SHALL accept file content as a string and SHALL return structured facts without performing filesystem access.

### Requirement 7: Environment Variable Extraction

**User Story:** As a developer, I want Repo Doctor to document the environment variables a repository uses, so that I can understand its configuration surface.

#### Acceptance Criteria

1. WHEN source files reference environment variables through recognized access patterns, THE Extractor SHALL extract the environment variable names as Extracted_Facts attributed to their source file paths.
2. WHEN an `.env.example` file is present in the Target_Repository, THE Extractor SHALL extract the declared environment variable names from that file as Extracted_Facts.
3. THE Extractor SHALL deduplicate environment variable names so that each distinct environment variable name appears once in `env.md`.
4. THE Markdown_Generator SHALL write the extracted environment variables to `env.md`.
5. THE environment variable Extractor SHALL accept file content as a string and SHALL return structured facts without performing filesystem access.

### Requirement 8: HTTP API Surface Extraction

**User Story:** As a developer, I want Repo Doctor to document the HTTP routes a repository exposes, so that I can understand its API surface.

#### Acceptance Criteria

1. WHEN source files contain HTTP route definitions recognized by the Relationship_Extractor, THE Extractor SHALL extract the route paths as Extracted_Facts attributed to their source file paths.
2. THE Markdown_Generator SHALL write the extracted HTTP routes to `api.md`.
3. WHERE the Target_Repository contains no recognizable HTTP routes, THE Markdown_Generator SHALL write `api.md` with an explicit statement that no HTTP routes were detected.

### Requirement 9: RabbitMQ Usage Extraction

**User Story:** As a developer, I want Repo Doctor to document RabbitMQ queues, exchanges, and message names, so that I can understand the repository's messaging surface.

#### Acceptance Criteria

1. WHEN source files contain queue, exchange, or message references recognized by the Relationship_Extractor, THE Extractor SHALL extract the queue names, exchange names, and message names as Extracted_Facts attributed to their source file paths.
2. THE Markdown_Generator SHALL write the extracted queue names, exchange names, and message names to `rabbitmq.md`.
3. WHERE the Target_Repository contains no recognizable RabbitMQ usage, THE Markdown_Generator SHALL write `rabbitmq.md` with an explicit statement that no RabbitMQ usage was detected.

### Requirement 10: Database Usage Extraction

**User Story:** As a developer, I want Repo Doctor to document the database tables a repository touches, so that I can understand its data surface.

#### Acceptance Criteria

1. WHEN source files contain database table references recognized by the Relationship_Extractor, THE Extractor SHALL extract the database table names as Extracted_Facts attributed to their source file paths.
2. THE Markdown_Generator SHALL write the extracted database table names to `database.md`.
3. WHERE the Target_Repository contains no recognizable database table references, THE Markdown_Generator SHALL write `database.md` with an explicit statement that no database usage was detected.

### Requirement 11: Overview and Architecture Document Generation

**User Story:** As a developer, I want Repo Doctor to produce an overview and an architecture document, so that I have a high-level summary of the repository.

#### Acceptance Criteria

1. THE Markdown_Generator SHALL write an `overview.md` containing the Target_Repository name and a summary of the counts of extracted services, environment variables, HTTP routes, RabbitMQ entities, and database tables.
2. THE Markdown_Generator SHALL write an `architecture.md` summarizing the detected services and the relationships extracted by the Relationship_Extractor.
3. THE Markdown_Generator SHALL produce each Generated_Document as valid Markdown content.

### Requirement 12: Complete Document Set and Run Reporting

**User Story:** As a developer, I want every documentation run to produce the full set of output files and a clear summary, so that I know the run succeeded and where to find the results.

#### Acceptance Criteria

1. WHEN a documentation run completes successfully, THE Repo_Doctor SHALL write all seven Generated_Documents (`overview.md`, `services.md`, `env.md`, `api.md`, `rabbitmq.md`, `database.md`, `architecture.md`) to the Output_Directory.
2. WHERE a Generated_Document has no extracted facts of its category, THE Markdown_Generator SHALL still write that Generated_Document with an explicit statement that no facts of that category were detected.
3. WHEN a documentation run completes successfully, THE Doctor_CLI SHALL report the Output_Directory path and the list of written Generated_Documents and SHALL exit with a zero status code.
4. IF an individual source file cannot be read or parsed, THEN THE Repo_Doctor SHALL record the failure as a `low` Confidence_Label Extracted_Fact identifying the source file path and SHALL continue the run to completion.

### Requirement 13: Pure Extractors Separated from Filesystem Access

**User Story:** As a maintainer, I want extraction logic kept pure and separate from filesystem access, so that extractors are small, testable, and reusable.

#### Acceptance Criteria

1. THE Repo_Doctor Extractors SHALL accept source content as strings and SHALL return structured facts without performing filesystem access.
2. THE Repo_Doctor SHALL confine filesystem reads of the Target_Repository to modules separate from the Extractor modules.
3. THE Repo_Doctor SHALL confine filesystem writes of Generated_Documents to modules separate from the Markdown_Generator modules.
4. THE Markdown_Generator functions SHALL accept structured facts and SHALL return Markdown content as strings without performing filesystem access.
