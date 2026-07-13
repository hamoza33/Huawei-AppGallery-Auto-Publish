"use client";
import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_LOCALE, TARGET_LOCALES } from "@/lib/locales";

interface AppOption {
  id: string;
  displayName: string;
  packageName: string;
}

const SCREENSHOT_SOURCES: Array<{ value: string; label: string; hint: string }> = [
  { value: "vmos", label: "VMOS emulator (real device)", hint: "Installs the APK on a cloud Android device and captures real screens from different stages." },
  { value: "ai_openai", label: "AI · ChatGPT (OpenAI gpt-image)", hint: "Generates store screenshots with OpenAI's gpt-image models (choose gpt-image-1 / gpt-image-2 in Settings). Prompts auto-built from the APK." },
  { value: "ai_gemini", label: "AI · nano banana (Gemini 2.5 Flash Image)", hint: "Generates store screenshots with Google's nano banana model." },
  { value: "template", label: "Template (icon + tagline)", hint: "Fast deterministic mockups using the app icon and generated taglines." },
];

const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB per chunk
const MAX_CONCURRENT = 4; // parallel chunk uploads

export function UploadDropzone({ apps }: { apps: AppOption[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedAppId, setSelectedAppId] = useState("");
  const [screenshotSource, setScreenshotSource] = useState("vmos");
  const [metadataPrompt, setMetadataPrompt] = useState("");
  const [screenshotPrompt, setScreenshotPrompt] = useState("");
  const [metadataLocales, setMetadataLocales] = useState<string[]>(TARGET_LOCALES.map((locale) => locale.bcp47));
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadPhase, setUploadPhase] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    setIsUploading(true);
    setProgress(0);

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // For small files (< 10 MB), use the simple single-request upload
    if (totalChunks <= 2) {
      return handleSimpleUpload(file);
    }

    try {
      // Phase 1: Init chunked session
      setUploadPhase("Initializing…");
      const initRes = await fetch("/api/uploads/chunked", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          totalSize: file.size,
          totalChunks,
          huaweiAppId: selectedAppId || undefined,
          screenshotSource,
          metadataLocales,
          metadataPrompt: metadataPrompt.trim() || undefined,
          screenshotPrompt: screenshotPrompt.trim() || undefined,
        }),
      });
      if (!initRes.ok) {
        const t = await initRes.text();
        throw new Error(`Init failed: ${t}`);
      }
      const { sessionId } = await initRes.json();

      // Phase 2: Upload chunks in parallel
      setUploadPhase("Uploading…");
      const chunksDone = new Array(totalChunks).fill(false);
      let nextChunk = 0;

      const updateProgress = () => {
        const done = chunksDone.filter(Boolean).length;
        setProgress(Math.round((done / totalChunks) * 95)); // reserve 5% for assembly
      };

      const uploadChunk = async (index: number): Promise<void> => {
        const start = index * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const blob = file.slice(start, end);

        const form = new FormData();
        form.append("chunk", blob, `chunk_${index}`);
        form.append("index", String(index));

        const maxRetries = 3;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          const res = await fetch(`/api/uploads/chunked/${sessionId}`, {
            method: "POST",
            body: form,
          });
          if (res.ok) {
            chunksDone[index] = true;
            updateProgress();
            return;
          }
          if (attempt === maxRetries - 1) {
            const t = await res.text();
            throw new Error(`Chunk ${index} failed after ${maxRetries} retries: ${t}`);
          }
          // Wait before retry with exponential backoff
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      };

      // Worker pool: N concurrent uploaders
      const workers = Array.from({ length: Math.min(MAX_CONCURRENT, totalChunks) }, async () => {
        while (true) {
          const idx = nextChunk++;
          if (idx >= totalChunks) break;
          await uploadChunk(idx);
        }
      });
      await Promise.all(workers);

      // Phase 3: Assemble on server
      setUploadPhase("Assembling…");
      setProgress(97);
      const completeRes = await fetch(`/api/uploads/chunked/${sessionId}/complete`, {
        method: "POST",
      });
      if (!completeRes.ok) {
        const t = await completeRes.text();
        throw new Error(`Assembly failed: ${t}`);
      }
      const { id } = await completeRes.json();
      setProgress(100);
      setIsUploading(false);
      router.push(`/uploads/${id}`);
    } catch (err) {
      setIsUploading(false);
      setUploadPhase("");
      setError(`Upload failed: ${(err as Error).message}`);
    }
  }

  async function handleSimpleUpload(file: File) {
    const form = new FormData();
    form.append("file", file);
    if (selectedAppId) form.append("huaweiAppId", selectedAppId);
    form.append("screenshotSource", screenshotSource);
    for (const locale of metadataLocales) form.append("metadataLocales", locale);
    if (metadataPrompt.trim()) form.append("metadataPrompt", metadataPrompt.trim());
    if (screenshotPrompt.trim()) form.append("screenshotPrompt", screenshotPrompt.trim());

    setUploadPhase("Uploading…");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/uploads");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      setIsUploading(false);
      setUploadPhase("");
      if (xhr.status >= 200 && xhr.status < 300) {
        const { id } = JSON.parse(xhr.responseText);
        router.push(`/uploads/${id}`);
      } else {
        setError(`Upload failed: ${xhr.responseText}`);
      }
    };
    xhr.onerror = () => {
      setIsUploading(false);
      setUploadPhase("");
      setError("Network error");
    };
    xhr.send(form);
  }

  const activeHint = SCREENSHOT_SOURCES.find((s) => s.value === screenshotSource)?.hint;
  const isAi = screenshotSource === "ai_openai" || screenshotSource === "ai_gemini";
  const selectedLocaleCount = metadataLocales.length;

  function toggleLocale(locale: string) {
    if (locale === DEFAULT_LOCALE) return;
    setMetadataLocales((current) =>
      current.includes(locale)
        ? current.filter((value) => value !== locale)
        : [...current, locale],
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="label">Target Huawei app</label>
        <select
          className="select"
          value={selectedAppId}
          onChange={(e) => setSelectedAppId(e.target.value)}
        >
          <option value="">Auto-detect from APK (recommended)</option>
          {apps.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName} ({a.packageName})
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-neutral-500">
          Auto-detect extracts the name + package ID from the APK and links the matching AppGallery
          app automatically.
        </p>
      </div>

      <div>
        <label className="label">Screenshots</label>
        <select
          className="select"
          value={screenshotSource}
          onChange={(e) => setScreenshotSource(e.target.value)}
        >
          {SCREENSHOT_SOURCES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        {activeHint && <p className="mt-1 text-xs text-neutral-500">{activeHint}</p>}
      </div>

      {isAi && (
        <div>
          <label className="label">Screenshot prompt (optional)</label>
          <textarea
            className="select min-h-[72px]"
            placeholder="e.g. 5 screenshots: title screen, choosing a dress, makeup studio, hair salon, final runway reveal with confetti."
            value={screenshotPrompt}
            onChange={(e) => setScreenshotPrompt(e.target.value)}
          />
          <p className="mt-1 text-xs text-neutral-500">
            Describe the concept or stages you want. The 4–5 AI screenshots are generated to match
            your description. Leave blank to auto-derive scenes from the APK.
          </p>
        </div>
      )}

      <div>
        <label className="label">Metadata languages</label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {TARGET_LOCALES.map((locale) => (
            <label
              key={locale.bcp47}
              className="flex items-center gap-2 rounded-md border border-neutral-200 px-3 py-2 text-sm"
            >
              <input
                type="checkbox"
                checked={metadataLocales.includes(locale.bcp47)}
                disabled={locale.bcp47 === DEFAULT_LOCALE}
                onChange={() => toggleLocale(locale.bcp47)}
              />
              <span>
                {locale.label} <span className="text-xs text-neutral-400">{locale.bcp47}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-neutral-500">
          {selectedLocaleCount} language{selectedLocaleCount === 1 ? "" : "s"} will be generated and uploaded. English is always included as the default listing.
        </p>
      </div>

      <div>
        <label className="label">Metadata prompt (optional)</label>
        <textarea
          className="select min-h-[72px]"
          placeholder="e.g. Emphasize that it's a relaxing dress-up game for kids; friendly, playful tone."
          value={metadataPrompt}
          onChange={(e) => setMetadataPrompt(e.target.value)}
        />
        <p className="mt-1 text-xs text-neutral-500">
          Steers the AI-written title/description. Leave blank to auto-generate from the APK.
        </p>
      </div>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f) handleFile(f);
        }}
        onClick={() => inputRef.current?.click()}
        className="cursor-pointer rounded-lg border-2 border-dashed border-neutral-300 bg-neutral-50 p-12 text-center transition-colors hover:border-brand hover:bg-neutral-100"
      >
        <input
          ref={inputRef}
          type="file"
          accept=".apk,application/vnd.android.package-archive"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
        <p className="text-neutral-600">
          Drop your <code>.apk</code> here or click to choose
        </p>
        <p className="mt-1 text-xs text-neutral-400">Up to 500 MB</p>
      </div>

      {isUploading && (
        <div>
          <div className="h-2 rounded-full bg-neutral-100">
            <div className="h-2 rounded-full bg-brand transition-all duration-300" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-1 text-xs text-neutral-500">{uploadPhase || "Uploading…"} {progress}%</p>
        </div>
      )}

      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      )}
    </div>
  );
}
