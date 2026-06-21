import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, any>;

type ConfigField = {
  id: string;
  name: string;
  options: Record<string, string>;
};

type Config = {
  owner: string;
  owner_type: "user" | "organization";
  project_number: number;
  project_node_id: string;
  org_db_id: number;
  project_db_id: number;
  fields: Record<string, ConfigField>;
};

type Item = {
  id: string;
  title: string;
  status: string;
  content: {
    id: string;
    title: string;
    body: string;
    type: string;
    url: string;
    number: number | null;
    repository: string;
  };
};

const DEFAULT_LIMIT = 100;

const ITEM_FIELDS_FRAGMENT = `
    id
    fieldValues(first: 20) {
        nodes {
            ... on ProjectV2ItemFieldSingleSelectValue {
                field { ... on ProjectV2SingleSelectField { name } }
                name
            }
        }
    }
    content {
        __typename
        ... on DraftIssue { id title body }
        ... on Issue { id title body url number repository { nameWithOwner } }
        ... on PullRequest { id title body url number repository { nameWithOwner } }
    }
`;

function usage(): string {
  return `ghp - ergonomic CLI wrapper for GitHub Projects

Usage:
  ghp status
  ghp setup <owner> <project-number>
  ghp add "task title" [--body "..."] [--status backlog] [--priority p1]
  ghp ls [--query "status:Backlog"] [--limit 100] [--json]
  ghp show <id>
  ghp edit <id> [--title "..."] [--body "..."] [--status done]
  ghp mv <id> <status>
  ghp archive <id>
  ghp delete <id>
  ghp id <id>

Full guide:
  ${fileURLToPath(new URL("../README.md", import.meta.url))}
`;
}

function configPath(): string {
  if (process.env.GHP_CONFIG) {
    return process.env.GHP_CONFIG;
  }
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "ghp", "config.json");
}

function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) {
    throw new Error(`No project configured. Run: ghp setup <owner> <number>`);
  }
  const config = readJsonFile(path) as Partial<Config>;
  for (const key of [
    "owner",
    "owner_type",
    "project_number",
    "project_node_id",
    "org_db_id",
    "project_db_id",
    "fields",
  ] as const) {
    if (config[key] === undefined || config[key] === null || config[key] === "") {
      throw new Error(`Missing ${key} in ${path}. Run: ghp setup <owner> <number>`);
    }
  }
  return config as Config;
}

function saveConfig(config: Config): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

function readJsonFile(path: string): JsonObject {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
  } catch (err) {
    throw new Error(`Failed to read JSON from ${path}`, { cause: err });
  }
}

function itemidToPvti(orgDbId: number, projectDbId: number, itemDbId: number): string {
  const data = Buffer.alloc(17);
  data[0] = 0x94;
  data[1] = 0x00;
  data[2] = 0xce;
  data.writeUInt32BE(orgDbId, 3);
  data[7] = 0xce;
  data.writeUInt32BE(projectDbId, 8);
  data[12] = 0xce;
  data.writeUInt32BE(itemDbId, 13);
  return `PVTI_${data.toString("base64url")}`;
}

function pvtiToItemid(nodeId: string): number {
  if (!nodeId.startsWith("PVTI_")) {
    throw new Error(`Expected PVTI_ node ID, got: ${nodeId}`);
  }
  const encoded = nodeId.slice("PVTI_".length);
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length < 17) {
    throw new Error(`Invalid PVTI_ node ID: ${nodeId}`);
  }
  return decoded.readUInt32BE(13);
}

function resolveId(cfg: Config, value: string): string {
  if (value.startsWith("PVTI_")) {
    return value;
  }
  const itemDbId = Number.parseInt(value, 10);
  if (!Number.isInteger(itemDbId)) {
    throw new Error(`Expected numeric item ID or PVTI_ node ID, got: ${value}`);
  }
  return itemidToPvti(cfg.org_db_id, cfg.project_db_id, itemDbId);
}

type GhResult = {
  stdout: string;
  stderr: string;
  status: number;
};

async function runGh(args: string[]): Promise<GhResult> {
  return await new Promise<GhResult>((resolve, reject) => {
    const child = spawn("gh", args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to run gh: ${err.message}`));
    });

    child.on("close", (status) => {
      resolve({ stdout, stderr, status: status || 0 });
    });
  });
}

async function gh(...args: string[]): Promise<string> {
  const result = await runGh(["project", ...args]);
  if (result.status !== 0) {
    console.error(`gh project ${args.join(" ")}`);
    if (result.stderr) {
      console.error(result.stderr.trimEnd());
    }
    process.exit(result.status || 1);
  }
  return result.stdout;
}

function ghGraphqlArgs(query: string, variables: Record<string, string | number>): string[] {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    args.push(typeof value === "string" ? "-f" : "-F", `${key}=${String(value)}`);
  }
  return args;
}

async function runGhGraphql(
  query: string,
  variables: Record<string, string | number>,
): Promise<GhResult> {
  return await runGh(ghGraphqlArgs(query, variables));
}

async function ghGraphql(
  query: string,
  variables: Record<string, string | number>,
): Promise<JsonObject> {
  const result = await runGhGraphql(query, variables);
  if (result.status !== 0) {
    if (result.stderr) {
      console.error(result.stderr.trimEnd());
    }
    process.exit(result.status || 1);
  }
  try {
    return JSON.parse(result.stdout) as JsonObject;
  } catch (err) {
    throw new Error("Failed to parse gh GraphQL response", { cause: err });
  }
}

function projectItemUrl(cfg: Config, node: JsonObject): string {
  if (!String(node.id || "").startsWith("PVTI_")) {
    return "";
  }
  const ownerPath = cfg.owner_type === "organization" ? "orgs" : "users";
  return `https://github.com/${ownerPath}/${cfg.owner}/projects/${cfg.project_number}/views/1?pane=issue&itemId=${pvtiToItemid(String(node.id))}`;
}

function gqlItemToDict(node: JsonObject, cfg: Config): Item {
  let status = "";
  for (const fieldValue of node.fieldValues?.nodes || []) {
    const field = fieldValue.field || {};
    if (field.name === "Status") {
      status = fieldValue.name || "";
    }
  }

  const content = node.content || {};
  return {
    id: String(node.id || ""),
    title: String(content.title || ""),
    status,
    content: {
      id: String(content.id || ""),
      title: String(content.title || ""),
      body: String(content.body || ""),
      type: String(content.__typename || ""),
      url: String(content.url || projectItemUrl(cfg, node)),
      number: typeof content.number === "number" ? content.number : null,
      repository: String(content.repository?.nameWithOwner || ""),
    },
  };
}

function itemContentKind(item: Item): string {
  switch (item.content.type) {
    case "DraftIssue":
      return "draft";
    case "Issue":
      return "issue";
    case "PullRequest":
      return "pr";
    default:
      return "";
  }
}

async function itemListGraphql(
  cfg: Config,
  limit: number,
  queryFilter?: string,
): Promise<[Item[], number]> {
  const query = `
    query($projectId: ID!, $limit: Int!, $filter: String) {
        node(id: $projectId) {
            ... on ProjectV2 {
                items(first: $limit, query: $filter) {
                    totalCount
                    nodes { ${ITEM_FIELDS_FRAGMENT} }
                }
            }
        }
    }`;

  const variables: Record<string, string | number> = { projectId: cfg.project_node_id, limit };
  if (queryFilter) {
    variables.filter = queryFilter;
  }

  const data = await ghGraphql(query, variables);
  const itemsData = data.data?.node?.items;
  if (!itemsData) {
    throw new Error("Project items not found in GraphQL response");
  }
  return [
    (itemsData.nodes || []).map((node: JsonObject) => gqlItemToDict(node, cfg)),
    Number(itemsData.totalCount || 0),
  ];
}

async function itemGetGraphql(cfg: Config, pvti: string): Promise<Item> {
  const query = `
    query($id: ID!) {
        node(id: $id) {
            ... on ProjectV2Item { ${ITEM_FIELDS_FRAGMENT} }
        }
    }`;
  const data = await ghGraphql(query, { id: pvti });
  const node = data.data?.node;
  if (!node?.id) {
    throw new Error(`Item not found: ${pvti}`);
  }
  return gqlItemToDict(node, cfg);
}

function resolveFieldOption(cfg: Config, fieldName: string, optionName: string): [string, string] {
  const fields = cfg.fields;
  const key = fieldName.toLowerCase();
  const field = fields[key];
  if (!field) {
    throw new Error(`Unknown field: ${fieldName}\nValid: ${Object.keys(fields).join(", ")}`);
  }

  const query = optionName.toLowerCase().trim();
  for (const [name, optionId] of Object.entries(field.options)) {
    if (name.toLowerCase() === query) {
      return [field.id, optionId];
    }
  }

  throw new Error(
    `Unknown ${fieldName} option: ${optionName}\nValid: ${Object.keys(field.options).join(", ")}`,
  );
}

async function setField(
  cfg: Config,
  pvti: string,
  fieldName: string,
  optionName: string,
): Promise<void> {
  const [fieldId, optionId] = resolveFieldOption(cfg, fieldName, optionName);
  await gh(
    "item-edit",
    "--id",
    pvti,
    "--project-id",
    cfg.project_node_id,
    "--field-id",
    fieldId,
    "--single-select-option-id",
    optionId,
  );
}

function cmdStatus(): void {
  const path = configPath();
  const hasConfig = existsSync(path);
  const cfg = hasConfig ? (readJsonFile(path) as Partial<Config>) : {};

  if (cfg.owner && cfg.project_number) {
    console.log(`Project: ${cfg.owner}/projects/${cfg.project_number}`);
  } else {
    console.log("Project: not configured");
  }
  console.log(`Config:  ${path}${hasConfig ? "" : " (missing)"}`);

  const fields = cfg.fields || {};
  const entries = Object.entries(fields);
  if (entries.length > 0) {
    console.log("");
    console.log("Fields:");
    for (const [name, field] of entries) {
      console.log(`  ${name}: ${Object.keys(field.options).join(", ")}`);
    }
  }
}

async function cmdSetup(args: string[]): Promise<void> {
  if (args.length !== 2) {
    throw new Error("Usage: ghp setup <owner> <project-number>");
  }
  const [owner, rawNumber] = args;
  const number = Number.parseInt(rawNumber, 10);
  if (!Number.isInteger(number)) {
    throw new Error(`Invalid project number: ${rawNumber}`);
  }

  let entity: JsonObject | undefined;
  let project: JsonObject | undefined;
  let ownerType: Config["owner_type"] | undefined;

  for (const gqlField of ["user", "organization"] as const) {
    const query = `
      query($login: String!, $number: Int!) {
        ${gqlField}(login: $login) {
          databaseId
          projectV2(number: $number) {
            id
            databaseId
            fields(first: 30) {
              nodes {
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options { id name }
                }
              }
            }
          }
        }
      }`;
    const result = await runGhGraphql(query, { login: owner, number });
    if (result.status !== 0) {
      continue;
    }
    let data: JsonObject;
    try {
      data = JSON.parse(result.stdout) as JsonObject;
    } catch (err) {
      throw new Error("Failed to parse gh GraphQL response", { cause: err });
    }
    const candidate = data.data?.[gqlField];
    if (candidate?.projectV2) {
      entity = candidate;
      project = candidate.projectV2;
      ownerType = gqlField;
      break;
    }
  }

  if (!entity || !project || !ownerType) {
    throw new Error(`Project not found: ${owner}/${number}`);
  }

  const fields: Config["fields"] = {};
  for (const node of project.fields?.nodes || []) {
    if (!node?.id || !node?.options) {
      continue;
    }
    const options: Record<string, string> = {};
    for (const option of node.options) {
      options[String(option.name)] = String(option.id);
    }
    fields[String(node.name).toLowerCase()] = {
      id: String(node.id),
      name: String(node.name),
      options,
    };
  }

  const path = configPath();
  const config: Config = {
    owner,
    owner_type: ownerType,
    project_number: number,
    project_node_id: String(project.id),
    org_db_id: Number(entity.databaseId),
    project_db_id: Number(project.databaseId),
    fields,
  };
  saveConfig(config);

  console.log(`Default set: ${owner}/projects/${number}`);
  console.log(`Config written to: ${path}`);
  console.log("Fields discovered:");
  for (const [name, field] of Object.entries(fields)) {
    console.log(`  ${name}: ${Object.keys(field.options).join(", ")}`);
  }
}

async function cmdAdd(args: string[]): Promise<void> {
  const parsed = parseCommandArgs(args, {
    valueFlags: new Map([
      ["--body", "body"],
      ["-b", "body"],
      ["--status", "status"],
      ["-s", "status"],
      ["--priority", "priority"],
      ["-p", "priority"],
    ]),
  });
  if (parsed.positionals.length !== 1) {
    throw new Error(
      'Usage: ghp add "task title" [--body "..."] [--status backlog] [--priority p1]',
    );
  }

  const cfg = loadConfig();
  const title = parsed.positionals[0];
  const isUrl = title.startsWith("https://");

  const raw = isUrl
    ? await gh(
        "item-add",
        String(cfg.project_number),
        "--owner",
        cfg.owner,
        "--url",
        title,
        "--format",
        "json",
      )
    : await gh(
        "item-create",
        String(cfg.project_number),
        "--owner",
        cfg.owner,
        "--title",
        title,
        ...(parsed.values.body ? ["--body", parsed.values.body] : []),
        "--format",
        "json",
      );

  const item = JSON.parse(raw) as JsonObject;
  const pvti = String(item.id);

  if (parsed.values.status) {
    await setField(cfg, pvti, "status", parsed.values.status);
  }
  if (parsed.values.priority) {
    await setField(cfg, pvti, "priority", parsed.values.priority);
  }

  const result: JsonObject = { id: pvti };
  if (!isUrl) {
    result.title = title;
  }
  if (parsed.values.status) {
    result.status = parsed.values.status;
  }
  if (parsed.values.priority) {
    result.priority = parsed.values.priority;
  }
  console.log(JSON.stringify(result, null, 2));
}

async function cmdLs(args: string[]): Promise<void> {
  const parsed = parseCommandArgs(args, {
    valueFlags: new Map([
      ["--query", "query"],
      ["-q", "query"],
      ["--limit", "limit"],
      ["-L", "limit"],
    ]),
    booleanFlags: new Map([
      ["--json", "json"],
      ["-j", "json"],
    ]),
  });
  if (parsed.positionals.length !== 0) {
    throw new Error('Usage: ghp ls [--query "status:Backlog"] [--limit 100] [--json]');
  }

  const limit = parsed.values.limit ? Number.parseInt(parsed.values.limit, 10) : DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Invalid limit: ${parsed.values.limit}`);
  }

  const cfg = loadConfig();
  const [items, total] = await itemListGraphql(cfg, limit, parsed.values.query);

  if (parsed.booleans.json) {
    console.log(JSON.stringify(items, null, 2));
  } else {
    console.log(`  ${"ID".padEnd(12)} ${"Status".padEnd(16)} ${"Kind".padEnd(6)} Title`);
    for (const item of items) {
      const itemId = item.id.startsWith("PVTI_") ? String(pvtiToItemid(item.id)) : "";
      console.log(
        `  ${itemId.padEnd(12)} ${item.status.padEnd(16)} ${itemContentKind(item).padEnd(6)} ${item.title}`,
      );
    }
  }

  if (total > limit) {
    console.error(`warning: showing ${limit} of ${total} items (use -L to increase)`);
  }
}

async function cmdShow(args: string[]): Promise<void> {
  if (args.length !== 1) {
    throw new Error("Usage: ghp show <id>");
  }
  const cfg = loadConfig();
  const pvti = resolveId(cfg, args[0]);
  const item = await itemGetGraphql(cfg, pvti);
  console.log(JSON.stringify(item, null, 2));
}

async function cmdEdit(args: string[]): Promise<void> {
  const parsed = parseCommandArgs(args, {
    valueFlags: new Map([
      ["--title", "title"],
      ["-t", "title"],
      ["--body", "body"],
      ["-b", "body"],
      ["--status", "status"],
      ["-s", "status"],
      ["--priority", "priority"],
      ["-p", "priority"],
    ]),
  });
  if (parsed.positionals.length !== 1) {
    throw new Error('Usage: ghp edit <id> [--title "..."] [--body "..."] [--status done]');
  }

  const cfg = loadConfig();
  const pvti = resolveId(cfg, parsed.positionals[0]);

  if (parsed.values.title || parsed.values.body) {
    const item = await itemGetGraphql(cfg, pvti);
    const contentId = item.content.id;
    if (!contentId || item.content.type !== "DraftIssue") {
      throw new Error(`Item has no editable draft issue content: ${pvti}`);
    }
    const editArgs = ["item-edit", "--id", contentId, "--project-id", cfg.project_node_id];
    if (parsed.values.title) {
      editArgs.push("--title", parsed.values.title);
    }
    if (parsed.values.body) {
      if (!parsed.values.title) {
        editArgs.push("--title", item.title);
      }
      editArgs.push("--body", parsed.values.body);
    }
    await gh(...editArgs);
  }

  if (parsed.values.status) {
    await setField(cfg, pvti, "status", parsed.values.status);
  }
  if (parsed.values.priority) {
    await setField(cfg, pvti, "priority", parsed.values.priority);
  }

  console.log(`Updated ${pvti}`);
}

async function cmdMv(args: string[]): Promise<void> {
  if (args.length !== 2) {
    throw new Error("Usage: ghp mv <id> <status>");
  }
  const cfg = loadConfig();
  const pvti = resolveId(cfg, args[0]);
  await setField(cfg, pvti, "status", args[1]);
  console.log(`Moved ${pvti} -> ${args[1]}`);
}

async function cmdArchive(args: string[]): Promise<void> {
  if (args.length !== 1) {
    throw new Error("Usage: ghp archive <id>");
  }
  const cfg = loadConfig();
  const pvti = resolveId(cfg, args[0]);
  await gh("item-archive", String(cfg.project_number), "--owner", cfg.owner, "--id", pvti);
  console.log(`Archived ${pvti}`);
}

async function cmdDelete(args: string[]): Promise<void> {
  if (args.length !== 1) {
    throw new Error("Usage: ghp delete <id>");
  }
  const cfg = loadConfig();
  const pvti = resolveId(cfg, args[0]);
  await gh("item-delete", String(cfg.project_number), "--owner", cfg.owner, "--id", pvti);
  console.log(`Deleted ${pvti}`);
}

function cmdId(args: string[]): void {
  if (args.length !== 1) {
    throw new Error("Usage: ghp id <id>");
  }
  const cfg = loadConfig();
  const value = args[0];
  if (value.startsWith("PVTI_")) {
    console.log(pvtiToItemid(value));
  } else {
    const itemDbId = Number.parseInt(value, 10);
    if (!Number.isInteger(itemDbId)) {
      throw new Error(`Expected numeric item ID or PVTI_ node ID, got: ${value}`);
    }
    console.log(itemidToPvti(cfg.org_db_id, cfg.project_db_id, itemDbId));
  }
}

type ParseOptions = {
  valueFlags?: Map<string, string>;
  booleanFlags?: Map<string, string>;
};

type ParsedArgs = {
  positionals: string[];
  values: Record<string, string>;
  booleans: Record<string, boolean>;
};

function parseCommandArgs(args: string[], options: ParseOptions): ParsedArgs {
  const valueFlags = options.valueFlags || new Map();
  const booleanFlags = options.booleanFlags || new Map();
  const parsed: ParsedArgs = { positionals: [], values: {}, booleans: {} };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (valueFlags.has(arg)) {
      const key = valueFlags.get(arg)!;
      const value = args[i + 1];
      if (value === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      parsed.values[key] = value;
      i += 1;
      continue;
    }
    if (booleanFlags.has(arg)) {
      parsed.booleans[booleanFlags.get(arg)!] = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    parsed.positionals.push(arg);
  }

  return parsed;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(usage());
    return;
  }

  switch (command) {
    case "status":
      cmdStatus();
      break;
    case "setup":
    case "set-default":
      await cmdSetup(args);
      break;
    case "add":
      await cmdAdd(args);
      break;
    case "ls":
      await cmdLs(args);
      break;
    case "show":
      await cmdShow(args);
      break;
    case "edit":
      await cmdEdit(args);
      break;
    case "mv":
      await cmdMv(args);
      break;
    case "archive":
      await cmdArchive(args);
      break;
    case "delete":
      await cmdDelete(args);
      break;
    case "id":
      cmdId(args);
      break;
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}

main().catch((err: unknown) => {
  console.error(String(err));
  process.exit(1);
});
