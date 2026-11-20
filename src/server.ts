import express, { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT_DIR, "output");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// =====================================================================
// 1. IN-MEMORY DATA STORE (Mocked SQLite replacement)
// =====================================================================
interface UserRecord {
  user_id: string;
  username: string;
  tier: string;
  credits: number;
  role: string;
}

interface TransactionRecord {
  tx_id: string;
  user_id: string;
  package: string;
  price_paid: number;
  credits_added: number;
  timestamp: string;
}

interface VideoJobRecord {
  job_id: string;
  user_id: string;
  prompt: string;
  status: string;
  filename: string;
  timestamp: string;
}

interface AIFeatureRecord {
  feature_id: string;
  title: string;
  prompt: string;
  backend_code: string;
  frontend_code: string;
  status: string;
  timestamp: string;
}

const users = new Map<string, UserRecord>([
  [
    "usr_001",
    {
      user_id: "usr_001",
      username: "พ่อธันวา (Nheng)",
      tier: "Creator",
      credits: 150,
      role: "admin",
    },
  ],
]);

const transactions: TransactionRecord[] = [];
const videoJobs = new Map<string, VideoJobRecord>();
const aiFeatures = new Map<string, AIFeatureRecord>();
const generatedFiles = new Map<string, Buffer>();

function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0");
}

function timestampCompact(withMicros = false): string {
  const d = new Date();
  const base =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  if (!withMicros) return base;
  return `${base}${pad(d.getMilliseconds(), 3)}${pad(Math.floor(Math.random() * 1000), 3)}`;
}

// Minimal valid ftyp + moov MP4 container bytes for downloadable placeholder output
function createMinimalMp4Buffer(): Buffer {
  const ftyp = Buffer.from([
    0x00, 0x00, 0x00, 0x18, // size 24
    0x66, 0x74, 0x79, 0x70, // 'ftyp'
    0x69, 0x73, 0x6f, 0x6d, // 'isom'
    0x00, 0x00, 0x02, 0x00, // minor_version
    0x69, 0x73, 0x6f, 0x6d, // 'isom'
    0x6d, 0x70, 0x34, 0x31, // 'mp41'
  ]);
  const mdat = Buffer.from([
    0x00, 0x00, 0x00, 0x08, // size 8
    0x6d, 0x64, 0x61, 0x74, // 'mdat'
  ]);
  return Buffer.concat([ftyp, mdat]);
}

// =====================================================================
// 2. BACKGROUND VIDEO PIPELINE (In-Memory / Output Artifact)
// =====================================================================
function updateJobStatus(jobId: string, status: string): void {
  const job = videoJobs.get(jobId);
  if (job) {
    job.status = status;
  }
}

async function generateSingleVideo(
  jobId: string,
  _prompt: string,
  filename: string
): Promise<void> {
  let safeName = path.basename(filename);
  if (!safeName.endsWith(".mp4")) {
    safeName += ".mp4";
  }

  const outputPath = path.join(OUTPUT_DIR, safeName);

  try {
    updateJobStatus(jobId, "processing");
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const mp4Data = createMinimalMp4Buffer();
    generatedFiles.set(safeName, mp4Data);
    fs.writeFileSync(outputPath, mp4Data);

    updateJobStatus(jobId, "completed");
  } catch (err) {
    console.error(`[ERROR] Video generation failed (${jobId}):`, err);
    updateJobStatus(jobId, "failed");
  }
}

// =====================================================================
// 3. EXPRESS APP & API ENDPOINTS
// =====================================================================
const app = express();
app.use(express.json());
app.use("/files", express.static(OUTPUT_DIR));

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "meta-flow-platform",
    time: new Date().toISOString(),
  });
});

app.get("/api/user/:user_id", (req: Request, res: Response) => {
  const user = users.get(String(req.params.user_id));
  if (user) {
    return res.json({ status: "success", data: user });
  }
  return res.status(404).json({ detail: "ไม่พบผู้ใช้" });
});

app.post("/api/billing/topup", (req: Request, res: Response) => {
  const userId = String(req.body?.user_id || "usr_001");
  const pkg = String(req.body?.package || "");

  const plans: Record<string, [number, number]> = {
    pack_s: [99.0, 50],
    pack_m: [299.0, 200],
    pack_l: [599.0, 500],
  };

  if (!(pkg in plans)) {
    return res.status(400).json({ detail: "แพ็กเกจไม่ถูกต้อง" });
  }

  const user = users.get(userId);
  if (!user) {
    return res.status(404).json({ detail: "ไม่พบผู้ใช้" });
  }

  const [price, creditsAdded] = plans[pkg];
  const nowIso = new Date().toISOString();
  const txId = `TX-${timestampCompact(true)}`;

  user.credits += creditsAdded;
  transactions.push({
    tx_id: txId,
    user_id: userId,
    package: pkg,
    price_paid: price,
    credits_added: creditsAdded,
    timestamp: nowIso,
  });

  return res.json({
    status: "success",
    new_balance: user.credits,
    tx_id: txId,
  });
});

app.post("/api/video/create", (req: Request, res: Response) => {
  const userId = String(req.body?.user_id || "usr_001");
  const prompt = String(req.body?.prompt || "").trim();
  const rawFilename = String(req.body?.filename || "").trim();

  if (!prompt) {
    return res.status(400).json({ detail: "กรุณาระบุ Prompt" });
  }

  const user = users.get(userId);
  if (!user) {
    return res.status(404).json({ detail: "ไม่พบผู้ใช้" });
  }

  const cost = 5;
  if (user.credits < cost) {
    return res
      .status(400)
      .json({ detail: `เครดิตไม่พอ (ต้องใช้ ${cost} เครดิต)` });
  }

  const nowIso = new Date().toISOString();
  const nowStr = `${timestampCompact(false)}_${Math.floor(Math.random() * 1000000)}`;
  let filename = rawFilename || `meta_${nowStr}.mp4`;
  if (!filename.endsWith(".mp4")) {
    filename += ".mp4";
  }
  filename = path.basename(filename);

  const jobId = `JOB-${timestampCompact(true)}`;
  const txId = `TX-${timestampCompact(true)}`;

  user.credits -= cost;
  transactions.push({
    tx_id: txId,
    user_id: userId,
    package: "video_gen",
    price_paid: 0.0,
    credits_added: -cost,
    timestamp: nowIso,
  });

  videoJobs.set(jobId, {
    job_id: jobId,
    user_id: userId,
    prompt,
    status: "queued",
    filename,
    timestamp: nowIso,
  });

  void generateSingleVideo(jobId, prompt, filename);

  return res.json({
    status: "success",
    message: "ส่งคิวสร้างวิดีโอเข้าสู่ Meta Flow แล้วครับ",
    job_id: jobId,
    filename,
  });
});

app.get("/api/video/jobs/:user_id", (req: Request, res: Response) => {
  const userId = String(req.params.user_id);
  const jobs = Array.from(videoJobs.values())
    .filter((j) => j.user_id === userId)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 20)
    .map((j) => {
      const fileExists =
        generatedFiles.has(j.filename) ||
        fs.existsSync(path.join(OUTPUT_DIR, j.filename));
      return {
        job_id: j.job_id,
        prompt: j.prompt,
        status: j.status,
        filename: j.filename,
        timestamp: j.timestamp,
        url: j.status === "completed" && fileExists ? `/files/${j.filename}` : null,
      };
    });

  return res.json({ status: "success", jobs });
});

app.get("/api/video/download/:filename", (req: Request, res: Response) => {
  const safeName = path.basename(String(req.params.filename));
  const filePath = path.join(OUTPUT_DIR, safeName);

  if (fs.existsSync(filePath)) {
    return res.download(filePath, safeName);
  }

  const memBuf = generatedFiles.get(safeName);
  if (memBuf) {
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    return res.send(memBuf);
  }

  return res.status(404).json({ detail: "ไม่พบไฟล์วิดีโอ" });
});

app.post("/api/admin/ai-feature/generate", (req: Request, res: Response) => {
  const cleanPrompt = String(req.body?.prompt || "").trim();
  if (!cleanPrompt) {
    return res.status(400).json({ detail: "กรุณากรอกคำสั่ง Prompt" });
  }

  const featureId = `FEAT-${timestampCompact(true)}`;
  const slug = featureId.toLowerCase().replace(/-/g, "_");
  const title =
    cleanPrompt.slice(0, 36) + (cleanPrompt.length > 36 ? "..." : "");
  const nowIso = new Date().toISOString();

  const backendCode =
    `// Auto-generated Express route for: ${cleanPrompt}\n` +
    `app.get('/api/modules/${slug}', (_req, res) => {\n` +
    `  res.json({ status: 'success', feature_id: '${featureId}', prompt: ${JSON.stringify(cleanPrompt)} });\n` +
    `});`;

  const frontendCode =
    `<div class='p-4 rounded-2xl bg-slate-900 border border-amber-500/30'>\n` +
    `  <h4 class='font-bold text-amber-400'>✨ ${cleanPrompt}</h4>\n` +
    `  <p class='text-xs text-slate-400 mt-1'>Module ID: ${featureId}</p>\n` +
    `</div>`;

  aiFeatures.set(featureId, {
    feature_id: featureId,
    title,
    prompt: cleanPrompt,
    backend_code: backendCode,
    frontend_code: frontendCode,
    status: "Draft",
    timestamp: nowIso,
  });

  return res.json({
    status: "success",
    feature_id: featureId,
    title,
    backend_code: backendCode,
    frontend_code: frontendCode,
    feature_status: "Draft",
  });
});

app.post("/api/admin/ai-feature/deploy", (req: Request, res: Response) => {
  const featureId = String(req.body?.feature_id || "");
  const feat = aiFeatures.get(featureId);
  if (!feat) {
    return res
      .status(404)
      .json({ detail: "ไม่พบฟีเจอร์ที่ต้องการ Deploy" });
  }
  feat.status = "Deployed";
  return res.json({
    status: "success",
    feature_id: featureId,
    feature_status: "Deployed",
  });
});

app.get("/api/admin/ai-features", (_req: Request, res: Response) => {
  const features = Array.from(aiFeatures.values())
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .map((f) => ({
      feature_id: f.feature_id,
      title: f.title,
      prompt: f.prompt,
      status: f.status,
      timestamp: f.timestamp,
    }));

  return res.json({ status: "success", features });
});

app.get("/api/admin/stats", (_req: Request, res: Response) => {
  const totalUsers = users.size;
  const totalRevenue = transactions
    .filter((t) => t.price_paid > 0)
    .reduce((sum, t) => sum + t.price_paid, 0);
  const totalJobs = videoJobs.size;
  const recentTxs = [...transactions]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 15);

  return res.json({
    total_users: totalUsers,
    total_revenue: totalRevenue,
    total_jobs: totalJobs,
    transactions: recentTxs,
  });
});

app.get("/", (_req: Request, res: Response) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Meta Flow Production Platform listening on http://0.0.0.0:${PORT}`);
});
