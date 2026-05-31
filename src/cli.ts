#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

type JsonObject = Record<string, any>;

type Config = {
  gh_token?: string;
  owner?: string;
  project_number?: number;
  project_node_id?: string;
  org_db_id?: number;
  project_db_id?: number;
  fields?: Record<
    string,
    {
      id: string;
      name: string;
      options: Record<string, string>;
    }
  >;
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
        ... on DraftIssue { id title body }
    }
`;

function usage(): string {
  return `ghp - ergonomic CLI wrapper for GitHub Projects

Usage:
  ghp auth
  ghp set-default <owner> <project-number>
  ghp add "task title" [--body "..."] [--status backlog] [--priority p1]
  ghp ls [--query "status:Backlog"] [--limit 100] [--json]
  ghp show <id>
  ghp edit <id> [--title "..."] [--body "..."] [--status done]
  ghp mv <id> <status>
  ghp archive <id>
  ghp delete <id>
  ghp id <id>
`;
}

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

function configPath(): string {
  if (process.env.GHP_CONFIG) {
    return process.env.GHP_CONFIG;
  }
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "ghp", "config.json");
}

function loadAuth(): void {
  if (process.env.GH_TOKEN) {
    return;
  }
  const path = configPath();
  if (!existsSync(path)) {
    return;
  }
  const cfg = readJsonFile(path) as Config;
  if (cfg.gh_token) {
    process.env.GH_TOKEN = cfg.gh_token;
  }
}

function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) {
    fail(`No project configured. Run: ghp set-default <owner> <number>`);
  }
  return readJsonFile(path) as Config;
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
    fail(`Failed to read JSON from ${path}: ${errorMessage(err)}`);
  }
}

function requireConfig<T>(cfg: Config, key: keyof Config): T {
  const value = cfg[key];
  if (value === undefined || value === null || value === "") {
    fail(`Missing ${String(key)} in ${configPath()}. Run: ghp set-default <owner> <number>`);
  }
  return value as T;
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
    fail(`Expected PVTI_ node ID, got: ${nodeId}`);
  }
  const encoded = nodeId.slice("PVTI_".length);
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length < 17) {
    fail(`Invalid PVTI_ node ID: ${nodeId}`);
  }
  return decoded.readUInt32BE(13);
}

function resolveId(cfg: Config, value: string): string {
  if (value.startsWith("PVTI_")) {
    return value;
  }
  const orgDbId = requireConfig<number>(cfg, "org_db_id");
  const projectDbId = requireConfig<number>(cfg, "project_db_id");
  const itemDbId = Number.parseInt(value, 10);
  if (!Number.isInteger(itemDbId)) {
    fail(`Expected numeric item ID or PVTI_ node ID, got: ${value}`);
  }
  return itemidToPvti(orgDbId, projectDbId, itemDbId);
}

function gh(...args: string[]): string {
  const result = spawnSync("gh", ["project", ...args], {
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) {
    fail(`Failed to run gh: ${result.error.message}`);
  }
  if (result.status !== 0) {
    console.error(`gh project ${args.join(" ")}`);
    if (result.stderr) {
      console.error(result.stderr.trimEnd());
    }
    process.exit(result.status || 1);
  }
  return result.stdout;
}

function ghGraphql(query: string, variables: Record<string, string | number>): JsonObject {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    args.push(typeof value === "string" ? "-f" : "-F", `${key}=${String(value)}`);
  }
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) {
    fail(`Failed to run gh: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (result.stderr) {
      console.error(result.stderr.trimEnd());
    }
    process.exit(result.status || 1);
  }
  try {
    return JSON.parse(result.stdout) as JsonObject;
  } catch (err) {
    fail(`Failed to parse gh GraphQL response: ${errorMessage(err)}`);
  }
}

function gqlItemToDict(node: JsonObject): Item {
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
      type: "DraftIssue",
    },
  };
}

function itemListGraphql(cfg: Config, limit: number, queryFilter?: string): [Item[], number] {
  const projectId = requireConfig<string>(cfg, "project_node_id");
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

  const variables: Record<string, string | number> = { projectId, limit };
  if (queryFilter) {
    variables.filter = queryFilter;
  }

  const data = ghGraphql(query, variables);
  const itemsData = data.data?.node?.items;
  if (!itemsData) {
    fail("Project items not found in GraphQL response");
  }
  return [
    (itemsData.nodes || []).map((node: JsonObject) => gqlItemToDict(node)),
    Number(itemsData.totalCount || 0),
  ];
}

function itemGetGraphql(_cfg: Config, pvti: string): Item {
  const query = `
    query($id: ID!) {
        node(id: $id) {
            ... on ProjectV2Item { ${ITEM_FIELDS_FRAGMENT} }
        }
    }`;
  const data = ghGraphql(query, { id: pvti });
  const node = data.data?.node;
  if (!node?.id) {
    fail(`Item not found: ${pvti}`);
  }
  return gqlItemToDict(node);
}

function resolveFieldOption(cfg: Config, fieldName: string, optionName: string): [string, string] {
  const fields = cfg.fields || {};
  const key = fieldName.toLowerCase();
  const field = fields[key];
  if (!field) {
    fail(`Unknown field: ${fieldName}\nValid: ${Object.keys(fields).join(", ")}`);
  }

  const query = optionName.toLowerCase().trim();
  for (const [name, optionId] of Object.entries(field.options)) {
    if (name.toLowerCase() === query) {
      return [field.id, optionId];
    }
  }

  fail(
    `Unknown ${fieldName} option: ${optionName}\nValid: ${Object.keys(field.options).join(", ")}`,
  );
}

function setField(cfg: Config, pvti: string, fieldName: string, optionName: string): void {
  const projectId = requireConfig<string>(cfg, "project_node_id");
  const [fieldId, optionId] = resolveFieldOption(cfg, fieldName, optionName);
  gh(
    "item-edit",
    "--id",
    pvti,
    "--project-id",
    projectId,
    "--field-id",
    fieldId,
    "--single-select-option-id",
    optionId,
  );
}

function cmdAuth(): void {
  const token = readFileSync(0, "utf8").trim();
  if (!token) {
    fail("Usage: echo TOKEN | ghp auth");
  }
  const path = configPath();
  const config = existsSync(path) ? (readJsonFile(path) as Config) : {};
  config.gh_token = token;
  saveConfig(config);
  console.log(`Token saved to ${path}`);
}

function cmdSetDefault(args: string[]): void {
  if (args.length !== 2) {
    fail("Usage: ghp set-default <owner> <project-number>");
  }
  const [owner, rawNumber] = args;
  const number = Number.parseInt(rawNumber, 10);
  if (!Number.isInteger(number)) {
    fail(`Invalid project number: ${rawNumber}`);
  }

  let entity: JsonObject | undefined;
  let project: JsonObject | undefined;

  for (const gqlField of ["organization", "user"]) {
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
    const data = ghGraphql(query, { login: owner, number });
    const candidate = data.data?.[gqlField];
    if (candidate?.projectV2) {
      entity = candidate;
      project = candidate.projectV2;
      break;
    }
  }

  if (!entity || !project) {
    fail(`Project not found: ${owner}/${number}`);
  }

  const fields: NonNullable<Config["fields"]> = {};
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
  const config = existsSync(path) ? (readJsonFile(path) as Config) : {};
  Object.assign(config, {
    owner,
    project_number: number,
    project_node_id: String(project.id),
    org_db_id: Number(entity.databaseId),
    project_db_id: Number(project.databaseId),
    fields,
  });
  saveConfig(config);

  console.log(`Default set: ${owner}/projects/${number}`);
  console.log(`Config written to: ${path}`);
  console.log("Fields discovered:");
  for (const [name, field] of Object.entries(fields)) {
    console.log(`  ${name}: ${Object.keys(field.options).join(", ")}`);
  }
}

function cmdAdd(args: string[]): void {
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
    fail('Usage: ghp add "task title" [--body "..."] [--status backlog] [--priority p1]');
  }

  const cfg = loadConfig();
  const title = parsed.positionals[0];
  const owner = requireConfig<string>(cfg, "owner");
  const projectNumber = requireConfig<number>(cfg, "project_number");
  const isUrl = title.startsWith("https://");

  const raw = isUrl
    ? gh("item-add", String(projectNumber), "--owner", owner, "--url", title, "--format", "json")
    : gh(
        "item-create",
        String(projectNumber),
        "--owner",
        owner,
        "--title",
        title,
        ...(parsed.values.body ? ["--body", parsed.values.body] : []),
        "--format",
        "json",
      );

  const item = JSON.parse(raw) as JsonObject;
  const pvti = String(item.id);

  if (parsed.values.status) {
    setField(cfg, pvti, "status", parsed.values.status);
  }
  if (parsed.values.priority) {
    setField(cfg, pvti, "priority", parsed.values.priority);
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

function cmdLs(args: string[]): void {
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
    fail('Usage: ghp ls [--query "status:Backlog"] [--limit 100] [--json]');
  }

  const limit = parsed.values.limit ? Number.parseInt(parsed.values.limit, 10) : DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    fail(`Invalid limit: ${parsed.values.limit}`);
  }

  const cfg = loadConfig();
  const [items, total] = itemListGraphql(cfg, limit, parsed.values.query);

  if (parsed.booleans.json) {
    console.log(JSON.stringify(items, null, 2));
  } else {
    for (const item of items) {
      const itemId = item.id.startsWith("PVTI_") ? String(pvtiToItemid(item.id)) : "";
      console.log(`  ${itemId.padEnd(12)} ${item.status.padEnd(16)} ${item.title}`);
    }
  }

  if (total > limit) {
    console.error(`warning: showing ${limit} of ${total} items (use -L to increase)`);
  }
}

function cmdShow(args: string[]): void {
  if (args.length !== 1) {
    fail("Usage: ghp show <id>");
  }
  const cfg = loadConfig();
  const pvti = resolveId(cfg, args[0]);
  const item = itemGetGraphql(cfg, pvti);
  console.log(JSON.stringify(item, null, 2));
}

function cmdEdit(args: string[]): void {
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
    fail('Usage: ghp edit <id> [--title "..."] [--body "..."] [--status done]');
  }

  const cfg = loadConfig();
  const pvti = resolveId(cfg, parsed.positionals[0]);

  if (parsed.values.title || parsed.values.body) {
    const projectId = requireConfig<string>(cfg, "project_node_id");
    const item = itemGetGraphql(cfg, pvti);
    const contentId = item.content.id;
    if (!contentId) {
      fail(`Item has no editable draft issue content: ${pvti}`);
    }
    const editArgs = ["item-edit", "--id", contentId, "--project-id", projectId];
    if (parsed.values.title) {
      editArgs.push("--title", parsed.values.title);
    }
    if (parsed.values.body) {
      if (!parsed.values.title) {
        editArgs.push("--title", item.title);
      }
      editArgs.push("--body", parsed.values.body);
    }
    gh(...editArgs);
  }

  if (parsed.values.status) {
    setField(cfg, pvti, "status", parsed.values.status);
  }
  if (parsed.values.priority) {
    setField(cfg, pvti, "priority", parsed.values.priority);
  }

  console.log(`Updated ${pvti}`);
}

function cmdMv(args: string[]): void {
  if (args.length !== 2) {
    fail("Usage: ghp mv <id> <status>");
  }
  const cfg = loadConfig();
  const pvti = resolveId(cfg, args[0]);
  setField(cfg, pvti, "status", args[1]);
  console.log(`Moved ${pvti} -> ${args[1]}`);
}

function cmdArchive(args: string[]): void {
  if (args.length !== 1) {
    fail("Usage: ghp archive <id>");
  }
  const cfg = loadConfig();
  const pvti = resolveId(cfg, args[0]);
  const owner = requireConfig<string>(cfg, "owner");
  const projectNumber = requireConfig<number>(cfg, "project_number");
  gh("item-archive", String(projectNumber), "--owner", owner, "--id", pvti);
  console.log(`Archived ${pvti}`);
}

function cmdDelete(args: string[]): void {
  if (args.length !== 1) {
    fail("Usage: ghp delete <id>");
  }
  const cfg = loadConfig();
  const pvti = resolveId(cfg, args[0]);
  const owner = requireConfig<string>(cfg, "owner");
  const projectNumber = requireConfig<number>(cfg, "project_number");
  gh("item-delete", String(projectNumber), "--owner", owner, "--id", pvti);
  console.log(`Deleted ${pvti}`);
}

function cmdId(args: string[]): void {
  if (args.length !== 1) {
    fail("Usage: ghp id <id>");
  }
  const cfg = loadConfig();
  const value = args[0];
  if (value.startsWith("PVTI_")) {
    console.log(pvtiToItemid(value));
  } else {
    const orgDbId = requireConfig<number>(cfg, "org_db_id");
    const projectDbId = requireConfig<number>(cfg, "project_db_id");
    const itemDbId = Number.parseInt(value, 10);
    if (!Number.isInteger(itemDbId)) {
      fail(`Expected numeric item ID or PVTI_ node ID, got: ${value}`);
    }
    console.log(itemidToPvti(orgDbId, projectDbId, itemDbId));
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
        fail(`Missing value for ${arg}`);
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
      fail(`Unknown option: ${arg}`);
    }
    parsed.positionals.push(arg);
  }

  return parsed;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function main(): void {
  loadAuth();

  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(usage());
    return;
  }

  switch (command) {
    case "auth":
      cmdAuth();
      break;
    case "set-default":
      cmdSetDefault(args);
      break;
    case "add":
      cmdAdd(args);
      break;
    case "ls":
      cmdLs(args);
      break;
    case "show":
      cmdShow(args);
      break;
    case "edit":
      cmdEdit(args);
      break;
    case "mv":
      cmdMv(args);
      break;
    case "archive":
      cmdArchive(args);
      break;
    case "delete":
      cmdDelete(args);
      break;
    case "id":
      cmdId(args);
      break;
    default:
      fail(`Unknown command: ${command}\n\n${usage()}`);
  }
}

main();
