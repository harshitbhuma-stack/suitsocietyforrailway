import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import postgres from "postgres";

function getProjectRef(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return null;
  const match = url.match(/https:\/\/([^.]+)\.supabase\.co/);
  return match?.[1] ?? null;
}

function buildConnectionUrls(password: string): string[] {
  const ref = getProjectRef();
  if (!ref || !password) return [];

  if (process.env.SUPABASE_DB_URL) {
    return [process.env.SUPABASE_DB_URL];
  }

  const encoded = encodeURIComponent(password);
  const regions = [
    "ap-northeast-1",
    "ap-south-1",
    "ap-southeast-1",
    "us-east-1",
    "us-west-1",
    "eu-west-1",
    "eu-central-1",
  ];
  const prefixes = ["aws-0", "aws-1"];
  const urls: string[] = [];

  // Direct connection — works when password is correct
  urls.push(`postgresql://postgres:${encoded}@db.${ref}.supabase.co:5432/postgres`);

  for (const prefix of prefixes) {
    for (const region of regions) {
      urls.push(`postgresql://postgres.${ref}:${encoded}@${prefix}-${region}.pooler.supabase.com:6543/postgres`);
      urls.push(`postgresql://postgres.${ref}:${encoded}@${prefix}-${region}.pooler.supabase.com:5432/postgres`);
    }
  }

  return [...new Set(urls)];
}

function classifyConnectionError(message: string): "auth" | "routing" | "other" {
  const lower = message.toLowerCase();
  if (lower.includes("password authentication failed") || lower.includes("authentication failed")) {
    return "auth";
  }
  if (
    lower.includes("enotfound") ||
    lower.includes("tenant/user") ||
    lower.includes("connect_timeout") ||
    lower.includes("econnrefused")
  ) {
    return "routing";
  }
  return "other";
}

function isIgnorableSqlError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("already exists") ||
    lower.includes("duplicate key") ||
    lower.includes("duplicate_object") ||
    (lower.includes("policy") && lower.includes("already")) ||
    lower.includes("multiple primary keys")
  );
}

function splitSqlStatements(schema: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inDollarBlock = false;

  for (let i = 0; i < schema.length; i++) {
    const nextTwo = schema.slice(i, i + 2);

    if (nextTwo === "$$") {
      inDollarBlock = !inDollarBlock;
      current += "$$";
      i++;
      continue;
    }

    if (schema[i] === ";" && !inDollarBlock) {
      const trimmed = current.trim();
      if (trimmed && !trimmed.startsWith("--")) {
        statements.push(trimmed);
      }
      current = "";
      continue;
    }

    current += schema[i];
  }

  const last = current.trim();
  if (last && !last.startsWith("--")) statements.push(last);

  return statements;
}

async function runSchema(sql: postgres.Sql, schema: string): Promise<void> {
  const statements = splitSqlStatements(schema);
  let executed = 0;

  for (const statement of statements) {
    try {
      await sql.unsafe(statement);
      executed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isIgnorableSqlError(message)) {
        throw error;
      }
    }
  }

  if (executed === 0) {
    await sql.unsafe(schema);
  }
}

async function tryRunSchema(connectionString: string, schema: string): Promise<{ ok: boolean; error?: string }> {
  const usePooler = connectionString.includes(":6543");
  const sql = postgres(connectionString, {
    ssl: "require",
    max: 1,
    connect_timeout: 10,
    idle_timeout: 10,
    prepare: !usePooler,
  });

  try {
    await runSchema(sql, schema);
    await sql.end({ timeout: 5 });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Database initialization failed";
    await sql.end({ timeout: 5 }).catch(() => undefined);
    if (isIgnorableSqlError(message)) {
      return { ok: true };
    }
    return { ok: false, error: message };
  }
}

function getMigrationFiles(): string[] {
  const migrationsDir = join(process.cwd(), "supabase", "migrations");
  if (!existsSync(migrationsDir)) return [];

  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => join(migrationsDir, file));
}

async function runWithPassword(
  dbPassword: string,
  run: (connectionString: string) => Promise<{ ok: boolean; error?: string }>
): Promise<{ success: boolean; error?: string }> {
  const urls = buildConnectionUrls(dbPassword);
  if (!urls.length) {
    return { success: false, error: "Could not build database connection URL." };
  }

  let lastError = "Could not connect to database. Check your Supabase database password.";
  let authError: string | undefined;

  for (const connectionString of urls) {
    const result = await run(connectionString);
    if (result.ok) return { success: true };
    const message = result.error || lastError;
    const kind = classifyConnectionError(message);
    if (kind === "auth") authError = message;
    else if (kind !== "routing") lastError = message;
  }

  if (authError) {
    return {
      success: false,
      error:
        "Wrong Supabase database password. Update SUPABASE_DB_PASSWORD in .env.local with the password from Supabase Dashboard → Settings → Database → Database password, then restart the dev server.",
    };
  }

  return { success: false, error: lastError };
}

export async function runMigrations(dbPassword?: string): Promise<{ success: boolean; error?: string }> {
  const password = dbPassword || process.env.SUPABASE_DB_PASSWORD;
  if (!password) {
    return {
      success: false,
      error: "Database password required. Set SUPABASE_DB_PASSWORD or pass dbPassword.",
    };
  }

  const migrationFiles = getMigrationFiles();
  if (!migrationFiles.length) {
    return { success: true };
  }

  return runWithPassword(password, async (connectionString) => {
    for (const filePath of migrationFiles) {
      const sql = readFileSync(filePath, "utf8");
      const result = await tryRunSchema(connectionString, sql);
      if (!result.ok) return result;
    }
    return { ok: true };
  });
}

export async function initializeDatabase(dbPassword?: string): Promise<{ success: boolean; error?: string }> {
  const password = dbPassword || process.env.SUPABASE_DB_PASSWORD;
  if (!password) {
    return {
      success: false,
      error: "Database password required. Supabase Dashboard → Settings → Database → Database password.",
    };
  }

  const urls = buildConnectionUrls(password);
  if (!urls.length) {
    return { success: false, error: "Could not build database connection URL." };
  }

  const bootstrapPath = join(process.cwd(), "supabase", "bootstrap.sql");
  const schemaPath = join(process.cwd(), "supabase", "schema.sql");
  const bootstrap = existsSync(bootstrapPath) ? readFileSync(bootstrapPath, "utf8") : "";
  const schema = readFileSync(schemaPath, "utf8");

  let lastError = "Could not connect to database. Check your Supabase database password.";
  let authError: string | undefined;

  for (const connectionString of urls) {
    if (bootstrap) {
      const boot = await tryRunSchema(connectionString, bootstrap);
      if (boot.ok) {
        const full = await tryRunSchema(connectionString, schema);
        if (full.ok) {
          const migrations = await runMigrations(password);
          if (migrations.success) return { success: true };
          return {
            success: true,
            error: migrations.error || "Schema OK. Run pending migrations from Admin → Settings.",
          };
        }
        return { success: true, error: "Bootstrap OK. Some full-schema steps may need manual SQL Editor run." };
      }
      const bootKind = classifyConnectionError(boot.error || "");
      if (bootKind === "auth") authError = boot.error;
      else if (bootKind !== "routing") lastError = boot.error || lastError;
      continue;
    }

    const result = await tryRunSchema(connectionString, schema);
    if (result.ok) {
      const migrations = await runMigrations(password);
      if (migrations.success) return { success: true };
      return {
        success: true,
        error: migrations.error || "Schema OK. Some migrations may need manual SQL Editor run.",
      };
    }
    const kind = classifyConnectionError(result.error || "");
    if (kind === "auth") authError = result.error;
    else if (kind !== "routing") lastError = result.error || lastError;
  }

  if (authError) {
    return {
      success: false,
      error:
        "Wrong Supabase database password. Update SUPABASE_DB_PASSWORD in .env.local with the password from Supabase Dashboard → Settings → Database → Database password, then restart the dev server.",
    };
  }

  return { success: false, error: lastError };
}

let autoInitPromise: Promise<{ dbReady: boolean; message?: string }> | null = null;

export async function ensureDatabaseReady(): Promise<{ dbReady: boolean; message?: string }> {
  if (autoInitPromise) return autoInitPromise;

  autoInitPromise = (async () => {
    const { createServiceClient } = await import("@/lib/supabase/server");
    const supabase = createServiceClient();

    const { error } = await supabase.from("admin_users").select("id").limit(1);
    if (!error) return { dbReady: true };

    const needsSchema =
      error.message.includes("admin_users") ||
      error.message.includes("schema cache") ||
      error.message.includes("does not exist");

    if (!needsSchema) {
      return { dbReady: false, message: error.message };
    }

    const password = process.env.SUPABASE_DB_PASSWORD;
    if (!password) {
      return {
        dbReady: false,
        message: "Set SUPABASE_DB_PASSWORD in .env.local to auto-initialize the database.",
      };
    }

    const result = await initializeDatabase(password);
    if (!result.success) {
      return { dbReady: false, message: result.error };
    }

    await runMigrations(password).catch(() => undefined);

    try {
      const { initializeDefaultAdmin } = await import("@/lib/auth");
      await initializeDefaultAdmin();
    } catch {
      // non-fatal
    }

    try {
      const { ensureStorageBuckets } = await import("@/lib/storage-setup");
      await ensureStorageBuckets();
    } catch {
      // non-fatal
    }

    const { error: recheck } = await supabase.from("admin_users").select("id").limit(1);
    if (recheck) {
      return { dbReady: false, message: recheck.message };
    }

    return { dbReady: true };
  })();

  try {
    return await autoInitPromise;
  } finally {
    autoInitPromise = null;
  }
}
