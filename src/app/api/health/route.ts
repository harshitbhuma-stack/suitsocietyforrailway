import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { ensureDatabaseReady } from "@/lib/init-db";

export async function GET() {
  try {
    await ensureDatabaseReady();

    const supabase = createServiceClient();
    const { error } = await supabase.from("admin_users").select("id").limit(1);

    if (error) {
      const needsSchema =
        error.message.includes("admin_users") ||
        error.message.includes("schema cache") ||
        error.message.includes("does not exist");

      return NextResponse.json({
        status: needsSchema ? "needs_schema" : "error",
        service: "Suit Society",
        dbReady: false,
        needsMigration: false,
        message: needsSchema
          ? "Run supabase/schema.sql in your Supabase SQL Editor."
          : error.message,
      });
    }

    const { error: migrationError } = await supabase.from("products").select("cost_price").limit(1);
    const needsMigration = Boolean(
      migrationError &&
        (migrationError.message.includes("cost_price") ||
          migrationError.message.includes("discount_percent") ||
          migrationError.message.includes("size_stock") ||
          migrationError.message.includes("schema cache"))
    );

    if (needsMigration) {
      return NextResponse.json({
        status: "needs_migration",
        service: "Suit Society",
        dbReady: true,
        needsMigration: true,
        message:
          "Database is missing product columns (cost_price, discount_percent, size_stock). Run migrations from Admin → Settings or apply supabase/migrations/005_product_enhancements.sql in Supabase SQL Editor.",
      });
    }

    return NextResponse.json({
      status: "ok",
      service: "Suit Society",
      dbReady: true,
      needsMigration: false,
    });
  } catch {
    return NextResponse.json({
      status: "error",
      service: "Suit Society",
      dbReady: false,
      needsMigration: false,
      message: "Could not connect to Supabase.",
    });
  }
}
