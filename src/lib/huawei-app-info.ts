// Applies a fixed "app info" template (category, privacy policy, distribution
// countries) to an AppGallery app via the documented Connect Publishing API.
//
// The Fastlane plugin used for upload/submit does NOT expose these fields, so we
// call the API directly:
//   POST /api/oauth2/v1/token        -> access token
//   GET  /api/publish/v2/app-info    -> read current app basic information
//   PUT  /api/publish/v2/app-info    -> update app basic information
// This is the same Connect API client_id/secret used everywhere else; no console
// login is required. Verified against a live app (appId 117918145).
//
// Schema notes (from the live API, not the older docs):
//  - Category is a 3-level numeric path: parentType / childType / grandChildType
//    (e.g. 2 / 20 / 10115 = Games / Role-playing / Incremental games).
//  - publishCountry is a comma-separated list of ISO codes. The GET response may
//    include a synthetic "ALL" token which the PUT rejects, so we always strip it.
//  - contentRate / age rating come from the console IARC questionnaire and are
//    NOT writable here, so they are intentionally omitted.
import { promises as fs } from "fs";
import path from "path";
import { huaweiCredsFromEnv, type FastlaneCredentials } from "./fastlane";

const CONNECT_BASE = "https://connect-api.cloud.huawei.com/api";

export interface AppInfoTemplate {
  defaultLang?: string;
  // Category path. Huawei needs all three levels together.
  parentType?: number;
  childType?: number;
  grandChildType?: number;
  // Comma-separated ISO country/region codes (no "ALL" token).
  publishCountry?: string;
  privacyPolicy?: string;
  // Device compatibility: 4 = Mobile Phone, 6 = Tablet (comma-separated IDs).
  deviceTypes?: string;
  // Payment: true = free app.
  isFree?: boolean;
  // Privacy declarations.
  collectPersonalData?: boolean;
  // AI function declaration: true = "Not involved".
  genAiNotInvolved?: boolean;
  // Release timing: true = "Immediately once approved".
  releaseImmediately?: boolean;
  // Auto-submit for review after upload.
  autoSubmitForReview?: boolean;
  // Auto-answer content-rating questionnaire with all "No".
  autoContentRating?: boolean;
  // Casual game sub-tag (relevant when category is Games).
  isGameCasual?: boolean;
}

type RetEnvelope = { ret?: { code?: number; msg?: string } };

// Keep only valid 2-letter ISO codes; drop Huawei's synthetic "ALL" token,
// blanks and duplicates while preserving order.
export function sanitizeCountries(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const c = part.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(c) && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out.length ? out.join(",") : undefined;
}

export async function getConnectToken(creds?: FastlaneCredentials): Promise<string> {
  const { clientId, clientSecret } = creds ?? huaweiCredsFromEnv();
  const res = await fetch(`${CONNECT_BASE}/oauth2/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    throw new Error(`Huawei OAuth failed (HTTP ${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Huawei OAuth returned no access_token");
  return data.access_token;
}

// Map our template to the API's body, omitting unset fields.
function buildPayload(t: AppInfoTemplate): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (t.defaultLang) p.defaultLang = t.defaultLang;
  if (typeof t.parentType === "number") p.parentType = t.parentType;
  if (typeof t.childType === "number") p.childType = t.childType;
  if (typeof t.grandChildType === "number") p.grandChildType = t.grandChildType;
  const pc = sanitizeCountries(t.publishCountry);
  if (pc) p.publishCountry = pc;
  if (t.privacyPolicy) p.privacyPolicy = t.privacyPolicy;
  // deviceTypes is set at app creation; sending it in updateAppInfo causes
  // "deviceTypes can not be chosen all" errors — omit from payload.
  if (typeof t.isFree === "boolean") p.isFree = t.isFree ? 1 : 0;
  return p;
}

export function templateIsEmpty(t: AppInfoTemplate): boolean {
  return Object.keys(buildPayload(t)).length === 0;
}

export interface RawAppInfo {
  defaultLang?: string;
  parentType?: number;
  childType?: number;
  grandChildType?: number;
  publishCountry?: string;
  privacyPolicy?: string;
  deviceTypes?: number[];
  isFree?: number;
  [k: string]: unknown;
}

// Read the current app basic information.
export async function fetchAppInfo(
  appId: string,
  opts: { creds?: FastlaneCredentials; releaseType?: 1 | 3 } = {},
): Promise<RawAppInfo> {
  const creds = opts.creds ?? huaweiCredsFromEnv();
  const token = await getConnectToken(creds);
  const releaseType = opts.releaseType ?? 1;
  const url = `${CONNECT_BASE}/publish/v2/app-info?appId=${encodeURIComponent(appId)}&releaseType=${releaseType}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, client_id: creds.clientId },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`app-info query failed (HTTP ${res.status}): ${text}`);
  const body = JSON.parse(text) as RetEnvelope & { appInfo?: RawAppInfo };
  if ((body.ret?.code ?? 0) !== 0) {
    throw new Error(`app-info query failed (code ${body.ret?.code}): ${body.ret?.msg ?? text}`);
  }
  return body.appInfo ?? {};
}

// Build a reusable template by capturing the fixed fields from an existing,
// already-configured app. This is the most robust way to get the exact category
// IDs and country list without guessing.
export function templateFromAppInfo(info: RawAppInfo): AppInfoTemplate {
  return {
    defaultLang: info.defaultLang,
    parentType: typeof info.parentType === "number" ? info.parentType : undefined,
    childType: typeof info.childType === "number" ? info.childType : undefined,
    grandChildType: typeof info.grandChildType === "number" ? info.grandChildType : undefined,
    publishCountry: sanitizeCountries(info.publishCountry),
    privacyPolicy: info.privacyPolicy || undefined,
    deviceTypes: Array.isArray(info.deviceTypes) ? info.deviceTypes.join(",") : undefined,
    isFree: typeof info.isFree === "number" ? info.isFree === 1 : undefined,
  };
}

export interface ApplyOptions {
  creds?: FastlaneCredentials;
  releaseType?: 1 | 3;
  onLog?: (line: string) => void | Promise<void>;
}

// PUT the template onto the app. Throws on auth/permission/validation errors.
export async function applyAppInfoTemplate(
  appId: string,
  template: AppInfoTemplate,
  opts: ApplyOptions = {},
): Promise<void> {
  const payload = buildPayload(template);
  if (Object.keys(payload).length === 0) {
    await opts.onLog?.("No app-info template fields configured; skipping");
    return;
  }
  const creds = opts.creds ?? huaweiCredsFromEnv();
  const token = await getConnectToken(creds);
  const releaseType = opts.releaseType ?? 1;
  await opts.onLog?.(`Applying app-info template: ${Object.keys(payload).join(", ")}`);

  const url = `${CONNECT_BASE}/publish/v2/app-info?appId=${encodeURIComponent(appId)}&releaseType=${releaseType}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      client_id: creds.clientId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`app-info update failed (HTTP ${res.status}): ${text}`);
  }
  let body: RetEnvelope = {};
  try {
    body = JSON.parse(text) as RetEnvelope;
  } catch {
    // Some success responses are empty; treat non-JSON 2xx as success.
  }
  const code = body.ret?.code ?? 0;
  if (code !== 0) {
    throw new Error(`app-info update failed (code ${code}): ${body.ret?.msg ?? text}`);
  }
  await opts.onLog?.("App-info template applied successfully");
}

// ---------------------- App Icon Upload ----------------------

// Upload the app icon to Huawei AppGallery Connect via the Publishing API.
// This is required before submit-for-review — the API returns error 204144660
// ("AppIcon is necessary!") if no icon has been uploaded.
//
// Flow:
//   1) GET /api/publish/v2/upload-url/for-obs?appId=X&fileName=icon.png&contentLength=Y&suffix=png
//   2) PUT the icon bytes to the returned OBS URL
//   3) PUT /api/publish/v2/app-file-info with fileType=1 (icon)
export async function uploadAppIcon(
  appId: string,
  iconPath: string,
  lang: string = "en-US",
  opts: ApplyOptions = {},
): Promise<void> {
  const creds = opts.creds ?? huaweiCredsFromEnv();
  const token = await getConnectToken(creds);

  // Read the icon file
  const iconBuffer = await fs.readFile(iconPath);
  const fileName = path.basename(iconPath);
  const fileSize = iconBuffer.byteLength;

  await opts.onLog?.(`Uploading app icon (${fileName}, ${fileSize} bytes)`);

  // 1) Get upload URL for the icon (suffix = png)
  const suffix = path.extname(iconPath).replace(".", "") || "png";
  const uploadUrlEndpoint =
    `${CONNECT_BASE}/publish/v2/upload-url/for-obs?appId=${encodeURIComponent(appId)}` +
    `&fileName=${encodeURIComponent(fileName)}&contentLength=${fileSize}&suffix=${suffix}`;

  const urlRes = await fetch(uploadUrlEndpoint, {
    headers: {
      Authorization: `Bearer ${token}`,
      client_id: creds.clientId,
    },
  });
  if (!urlRes.ok) {
    throw new Error(`Failed to get icon upload URL (HTTP ${urlRes.status}): ${await urlRes.text()}`);
  }
  const urlData = (await urlRes.json()) as {
    urlInfo?: { url?: string; objectId?: string; headers?: Record<string, string> };
    ret?: { code?: number; msg?: string };
  };
  if ((urlData.ret?.code ?? 0) !== 0) {
    throw new Error(`Failed to get icon upload URL (code ${urlData.ret?.code}): ${urlData.ret?.msg}`);
  }
  if (!urlData.urlInfo?.url || !urlData.urlInfo?.objectId) {
    throw new Error("No upload URL returned for icon");
  }

  // 2) Upload the icon to OBS
  const obsUrl = urlData.urlInfo.url;
  const obsHeaders: Record<string, string> = {};
  if (urlData.urlInfo.headers) {
    for (const [k, v] of Object.entries(urlData.urlInfo.headers)) {
      obsHeaders[k] = v;
    }
  }
  obsHeaders["Content-Type"] = "application/octet-stream";

  const obsRes = await fetch(obsUrl, {
    method: "PUT",
    headers: obsHeaders,
    body: iconBuffer,
  });
  if (!obsRes.ok) {
    throw new Error(`Failed to upload icon to OBS (HTTP ${obsRes.status}): ${await obsRes.text()}`);
  }
  await opts.onLog?.("Icon uploaded to OBS storage");

  // 3) Register the uploaded icon file with fileType=0 (app icon)
  //    Note: fileType 0 = icon, 1 = video/poster, 2 = screenshot, 5 = APK/RPK
  const fileInfoUrl = `${CONNECT_BASE}/publish/v2/app-file-info?appId=${encodeURIComponent(appId)}`;
  const fileInfoRes = await fetch(fileInfoUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      client_id: creds.clientId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fileType: 0,
      lang,
      files: [{ fileName, fileDestUrl: urlData.urlInfo.objectId }],
    }),
  });
  const fileInfoText = await fileInfoRes.text();
  if (!fileInfoRes.ok) {
    throw new Error(`Failed to register icon file (HTTP ${fileInfoRes.status}): ${fileInfoText}`);
  }
  let fileInfoBody: RetEnvelope = {};
  try {
    fileInfoBody = JSON.parse(fileInfoText) as RetEnvelope;
  } catch {
    // Non-JSON 2xx is success
  }
  const code = fileInfoBody.ret?.code ?? 0;
  if (code !== 0) {
    throw new Error(`Failed to register icon file (code ${code}): ${fileInfoBody.ret?.msg ?? fileInfoText}`);
  }
  await opts.onLog?.("App icon registered successfully");
}

/**
 * Upload screenshots to Huawei AppGallery Connect.
 * fileType 2 = screenshots. Requires at least 3 images.
 */
export async function uploadScreenshots(
  appId: string,
  screenshotPaths: string[],
  lang: string = "en-US",
  opts: ApplyOptions = {},
): Promise<void> {
  if (screenshotPaths.length < 3) {
    throw new Error(`Huawei requires at least 3 screenshots, got ${screenshotPaths.length}`);
  }
  const creds = opts.creds ?? huaweiCredsFromEnv();
  const token = await getConnectToken(creds);

  await opts.onLog?.(`Uploading ${screenshotPaths.length} screenshots for locale ${lang}`);

  const uploadedFiles: { fileName: string; fileDestUrl: string }[] = [];

  for (let i = 0; i < screenshotPaths.length; i++) {
    const ssPath = screenshotPaths[i];
    const buffer = await fs.readFile(ssPath);
    const fileName = path.basename(ssPath);
    const fileSize = buffer.byteLength;
    const suffix = path.extname(ssPath).replace(".", "") || "png";

    // Get upload URL
    const uploadUrlEndpoint =
      `${CONNECT_BASE}/publish/v2/upload-url/for-obs?appId=${encodeURIComponent(appId)}` +
      `&fileName=${encodeURIComponent(fileName)}&contentLength=${fileSize}&suffix=${suffix}`;

    const urlRes = await fetch(uploadUrlEndpoint, {
      headers: {
        Authorization: `Bearer ${token}`,
        client_id: creds.clientId,
      },
    });
    if (!urlRes.ok) {
      throw new Error(`Failed to get screenshot upload URL (HTTP ${urlRes.status})`);
    }
    const urlData = (await urlRes.json()) as {
      urlInfo?: { url?: string; objectId?: string; headers?: Record<string, string> };
      ret?: { code?: number; msg?: string };
    };
    if ((urlData.ret?.code ?? 0) !== 0 || !urlData.urlInfo?.url || !urlData.urlInfo?.objectId) {
      throw new Error(`Failed to get upload URL for screenshot ${i + 1}`);
    }

    // Upload to OBS
    const obsHeaders: Record<string, string> = {};
    if (urlData.urlInfo.headers) {
      for (const [k, v] of Object.entries(urlData.urlInfo.headers)) {
        obsHeaders[k] = v;
      }
    }
    obsHeaders["Content-Type"] = "application/octet-stream";

    const obsRes = await fetch(urlData.urlInfo.url, {
      method: "PUT",
      headers: obsHeaders,
      body: buffer,
    });
    if (!obsRes.ok) {
      throw new Error(`Failed to upload screenshot ${i + 1} to OBS (HTTP ${obsRes.status})`);
    }

    uploadedFiles.push({ fileName, fileDestUrl: urlData.urlInfo.objectId });
    await opts.onLog?.(`Screenshot ${i + 1}/${screenshotPaths.length} uploaded to OBS`);
  }

  // Register all screenshots with fileType=2
  const fileInfoUrl = `${CONNECT_BASE}/publish/v2/app-file-info?appId=${encodeURIComponent(appId)}`;
  const fileInfoRes = await fetch(fileInfoUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      client_id: creds.clientId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fileType: 2,
      lang,
      files: uploadedFiles,
    }),
  });
  const fileInfoText = await fileInfoRes.text();
  if (!fileInfoRes.ok) {
    throw new Error(`Failed to register screenshots (HTTP ${fileInfoRes.status}): ${fileInfoText}`);
  }
  let fileInfoBody: RetEnvelope = {};
  try {
    fileInfoBody = JSON.parse(fileInfoText) as RetEnvelope;
  } catch {
    // Non-JSON 2xx is success
  }
  const code = fileInfoBody.ret?.code ?? 0;
  if (code !== 0) {
    throw new Error(`Failed to register screenshots (code ${code}): ${fileInfoBody.ret?.msg ?? fileInfoText}`);
  }
  await opts.onLog?.(`${uploadedFiles.length} screenshots registered successfully`);
}

// ---------------------- App Info Setup via Playwright CDP (fallback) ----------------------
//
// When the API-based applyAppInfoTemplate fails (e.g. "US not exist" for new
// apps), this function spawns scripts/setup-app-info.js which uses the console
// UI to set Category and Countries.

export async function applyAppInfoViaConsole(
  appId: string,
  opts: ApplyOptions = {},
): Promise<void> {
  const cdpUrl = process.env.CDP_URL || "http://localhost:9222";
  await opts.onLog?.(`API template failed — falling back to console automation (CDP ${cdpUrl})`);

  const scriptPath = path.join(process.cwd(), "scripts", "setup-app-info.js");
  try {
    await fs.access(scriptPath);
  } catch {
    throw new Error(
      `Setup script not found at ${scriptPath}. ` +
      `Ensure scripts/setup-app-info.js exists in the project root.`
    );
  }

  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  try {
    const { stdout, stderr } = await execFileAsync(
      "node",
      [scriptPath, appId, cdpUrl],
      { timeout: 180_000, env: { ...process.env, CDP_URL: cdpUrl } },
    );
    if (stdout) {
      for (const line of stdout.split("\n").filter(Boolean)) {
        await opts.onLog?.(`[console-setup] ${line}`);
      }
    }
    if (stderr) {
      for (const line of stderr.split("\n").filter(Boolean)) {
        await opts.onLog?.(`[console-setup:err] ${line}`);
      }
    }
    await opts.onLog?.("App info (Category + Countries) set via console automation");
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("ECONNREFUSED") || msg.includes("connect")) {
      throw new Error(
        `Cannot connect to Chrome CDP at ${cdpUrl}. ` +
        `Ensure Chrome is running with remote debugging enabled.`
      );
    }
    throw new Error(`Console app-info setup failed: ${msg}`);
  }
}

// ---------------------- Content Rating via Playwright CDP ----------------------
//
// Huawei does NOT expose a working age-rating API (returns 404). The content
// rating questionnaire must be completed via the console UI. This function
// spawns scripts/content-rating.js which connects to an existing Chrome
// session via CDP and automates the questionnaire.
//
// Prerequisites:
//   - Chrome must be running with --remote-debugging-port
//   - Chrome must be logged into Huawei AppGallery Connect
//   - The app must already have Category and Countries set (mandatory order)
//   - Set CDP_URL env var (default: http://localhost:9222)

export async function submitAgeRatingAllNo(
  appId: string,
  opts: ApplyOptions = {},
): Promise<void> {
  const cdpUrl = process.env.CDP_URL || "http://localhost:9222";
  await opts.onLog?.(`Running content rating automation via Playwright CDP (${cdpUrl})`);

  const scriptPath = path.join(process.cwd(), "scripts", "content-rating.js");
  try {
    await fs.access(scriptPath);
  } catch {
    throw new Error(
      `Content rating script not found at ${scriptPath}. ` +
      `Ensure scripts/content-rating.js exists in the project root.`
    );
  }

  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  try {
    const { stdout, stderr } = await execFileAsync(
      "node",
      [scriptPath, appId, cdpUrl],
      { timeout: 120_000, env: { ...process.env, CDP_URL: cdpUrl } },
    );
    if (stdout) {
      for (const line of stdout.split("\n").filter(Boolean)) {
        await opts.onLog?.(`[content-rating] ${line}`);
      }
    }
    if (stderr) {
      for (const line of stderr.split("\n").filter(Boolean)) {
        await opts.onLog?.(`[content-rating:err] ${line}`);
      }
    }
    await opts.onLog?.("Content rating (all No) completed via Playwright");
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("ECONNREFUSED") || msg.includes("connect")) {
      throw new Error(
        `Cannot connect to Chrome CDP at ${cdpUrl}. ` +
        `Ensure Chrome is running with remote debugging enabled and you are logged into Huawei console. ` +
        `Set CDP_URL env var if using a different port.`
      );
    }
    throw new Error(`Content rating automation failed: ${msg}`);
  }
}
