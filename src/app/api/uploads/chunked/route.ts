import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { normalizeTargetLocales } from "@/lib/locales";

export const runtime = "nodejs";

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");

/**
 * POST /api/uploads/chunked
 * Initialize a chunked upload session.
 * Body JSON: { filename, totalSize, totalChunks, huaweiAppId?, metadataPrompt?, screenshotPrompt?, screenshotSource? }
 * Returns: { sessionId }
 */
export async function POST(req: Request) {
  const body = await req.json();
  const { filename, totalSize, totalChunks } = body as {
    filename: string;
    totalSize: number;
    totalChunks: number;
  };

  if (!filename || !totalSize || !totalChunks) {
    return NextResponse.json(
      { error: "Missing required fields: filename, totalSize, totalChunks" },
      { status: 400 },
    );
  }
  if (!filename.toLowerCase().endsWith(".apk")) {
    return NextResponse.json({ error: "Only .apk files are accepted" }, { status: 400 });
  }

  const sessionId = crypto.randomUUID();
  const sessionDir = path.join(UPLOAD_DIR, "_chunks", sessionId);
  await fs.mkdir(sessionDir, { recursive: true });

  // Persist session metadata
  await fs.writeFile(
    path.join(sessionDir, "_meta.json"),
    JSON.stringify({
      filename,
      totalSize,
      totalChunks,
      huaweiAppId: body.huaweiAppId || null,
      metadataPrompt: body.metadataPrompt || null,
      screenshotPrompt: body.screenshotPrompt || null,
      screenshotSource: body.screenshotSource || "vmos",
      metadataLocales: normalizeTargetLocales(body.metadataLocales),
      createdAt: Date.now(),
    }),
  );

  return NextResponse.json({ sessionId });
}
