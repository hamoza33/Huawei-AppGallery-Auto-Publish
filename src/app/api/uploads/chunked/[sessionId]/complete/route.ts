import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 120;

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");

interface SessionMeta {
  filename: string;
  totalSize: number;
  totalChunks: number;
  huaweiAppId: string | null;
  metadataPrompt: string | null;
  screenshotPrompt: string | null;
  screenshotSource: string;
  metadataLocales?: string[];
}

/**
 * POST /api/uploads/chunked/[sessionId]/complete
 * Assemble chunks into the final APK and create the Upload record.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const sessionDir = path.join(UPLOAD_DIR, "_chunks", sessionId);

  let meta: SessionMeta;
  try {
    const raw = await fs.readFile(path.join(sessionDir, "_meta.json"), "utf-8");
    meta = JSON.parse(raw) as SessionMeta;
  } catch {
    return NextResponse.json({ error: "Invalid or expired session" }, { status: 404 });
  }

  // Validate huaweiAppId if provided
  if (meta.huaweiAppId) {
    const exists = await prisma.huaweiApp.findUnique({ where: { id: meta.huaweiAppId } });
    if (!exists) return NextResponse.json({ error: "Unknown huaweiAppId" }, { status: 400 });
  }

  // Verify all chunks exist
  for (let i = 0; i < meta.totalChunks; i++) {
    try {
      await fs.access(path.join(sessionDir, `chunk_${i}`));
    } catch {
      return NextResponse.json(
        { error: `Missing chunk ${i} of ${meta.totalChunks}` },
        { status: 400 },
      );
    }
  }

  // Create upload record first
  const upload = await prisma.upload.create({
    data: {
      huaweiAppId: meta.huaweiAppId,
      filename: meta.filename,
      apkPath: "",
      apkSize: BigInt(meta.totalSize),
      apkSha256: "",
      metadataPrompt: meta.metadataPrompt,
      screenshotPrompt: meta.screenshotPrompt,
      screenshotSource: meta.screenshotSource,
      metadataLocales: meta.metadataLocales ?? ["en-US"],
      autoCreateApp: !meta.huaweiAppId,
    },
  });

  // Assemble chunks into final APK
  const destDir = path.join(UPLOAD_DIR, upload.id);
  await fs.mkdir(destDir, { recursive: true });
  const apkPath = path.join(destDir, meta.filename);

  const hash = crypto.createHash("sha256");
  const writeHandle = await fs.open(apkPath, "w");
  try {
    for (let i = 0; i < meta.totalChunks; i++) {
      const chunkBuf = await fs.readFile(path.join(sessionDir, `chunk_${i}`));
      hash.update(chunkBuf);
      await writeHandle.write(chunkBuf);
    }
  } finally {
    await writeHandle.close();
  }

  const sha = hash.digest("hex");

  await prisma.upload.update({
    where: { id: upload.id },
    data: { apkPath, apkSha256: sha },
  });
  await prisma.job.create({
    data: { uploadId: upload.id, kind: "PARSE_APK", status: "QUEUED" },
  });
  await prisma.uploadEvent.create({
    data: { uploadId: upload.id, level: "info", message: "Upload received (chunked); queued for parsing" },
  });

  // Clean up chunk files in background
  fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});

  return NextResponse.json({ id: upload.id });
}
