const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const os = require("os");
const { promisify } = require("util");
const mime = require("mime-types");
const { pipeline } = require("stream/promises");



// ── Variable To Help Function ──────────────────────────────────────────
const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 4000;
const FILMS_PATH = process.env.FILMS_PATH || "/mnt/harddisk/Film";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const SUPPORTED_FORMATS = [".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v"];

// CORS
app.use(cors({
  origin: ALLOWED_ORIGIN,
  methods: ["GET", "HEAD", "OPTIONS"],
}));

// ── Helper ──────────────────────────────────────────

function parseFilmName(filename) {
  const ext = path.extname(filename);
  const name = path.basename(filename, ext);
  const match = name.match(/^(.+?)\s*\((\d{4})\)$/);
  if (match) return { title: match[1].trim(), year: match[2] };
  return { title: name.trim(), year: null };
}

function srtToVtt(srt) {
  let vtt = "WEBVTT\n\n";
  const blocks = srt.trim().split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 3) continue;
    let i = 0;
    if (/^\d+$/.test(lines[0].trim())) i = 1;
    const timestamp = lines[i]?.replace(/,/g, ".");
    if (!timestamp || !timestamp.includes("-->")) continue;
    const text = lines.slice(i + 1).join("\n");
    vtt += `${timestamp}\n${text}\n\n`;
  }
  return vtt;
}

// Cache resource usage, update setiap 5 menit
let resourceCache = null;
let lastUpdate = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 menit

function getResourceUsage() {
  const now = Date.now();
  if (resourceCache && now - lastUpdate < CACHE_DURATION) {
    return resourceCache;
  }

  // CPU usage (average load 1 menit)
  const cpuLoad = os.loadavg()[0];
  const cpuCount = os.cpus().length;
  const cpuPercent = Math.min((cpuLoad / cpuCount) * 100, 100).toFixed(1);

  // RAM
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  // Disk usage (Linux)
  let disk = null;
  try {
    const df = execSync("df -k / --output=size,used,avail | tail -1")
      .toString()
      .trim()
      .split(/\s+/);
    disk = {
      total: Math.round(parseInt(df[0]) / 1024 / 1024), // GB
      used: Math.round(parseInt(df[1]) / 1024 / 1024),
      free: Math.round(parseInt(df[2]) / 1024 / 1024),
      percent: ((parseInt(df[1]) / parseInt(df[0])) * 100).toFixed(1),
    };
  } catch {
    disk = null;
  }

  // Uptime
  const uptimeSeconds = os.uptime();
  const days = Math.floor(uptimeSeconds / 86400);
  const hours = Math.floor((uptimeSeconds % 86400) / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);

  resourceCache = {
    updatedAt: new Date().toISOString(),
    cpu: {
      percent: parseFloat(cpuPercent),
      cores: cpuCount,
      model: os.cpus()[0]?.model || "Unknown",
    },
    ram: {
      total: Math.round(totalMem / 1024 / 1024), // MB
      used: Math.round(usedMem / 1024 / 1024),
      free: Math.round(freeMem / 1024 / 1024),
      percent: ((usedMem / totalMem) * 100).toFixed(1),
    },
    disk,
    uptime: { days, hours, minutes, seconds: Math.floor(uptimeSeconds) },
    platform: os.platform(),
    hostname: os.hostname(),
  };

  lastUpdate = now;
  return resourceCache;
}

// ── Routes ──────────────────────────────────────────

const MEDIA_DIR = process.env.FILMS_PATH || "/mnt/harddisk/Film";

// Helper: resolve path dengan aman
function safePath(filePath) {
  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(MEDIA_DIR, filePath);
  if (!resolved.startsWith(path.resolve(MEDIA_DIR))) return null;
  return resolved;
}

// ─── DELETE FILE ───────────────────────────────────────────
app.delete("/api/files/delete", (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: "filePath diperlukan" });

    const resolved = safePath(filePath);
    if (!resolved) return res.status(403).json({ error: "Akses ditolak" });
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: "File tidak ditemukan" });

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      fs.rmSync(resolved, { recursive: true, force: true });
    } else {
      fs.unlinkSync(resolved);
    }

    res.json({ success: true, deleted: resolved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DOWNLOAD FILE ─────────────────────────────────────────
app.get("/api/files/download", (req, res) => {
  try {
    const { filePath } = req.query;
    if (!filePath) return res.status(400).json({ error: "filePath diperlukan" });

    const resolved = safePath(filePath); // ← fix: pakai safePath bukan path.resolve langsung
    if (!resolved) return res.status(403).json({ error: "Akses ditolak" });
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: "File tidak ditemukan" });

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) return res.status(400).json({ error: "Tidak bisa download folder" });

    const filename = path.basename(resolved);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", stat.size);

    const stream = fs.createReadStream(resolved);
    stream.pipe(res);
    stream.on("error", (err) => {
      console.error("Stream error:", err);
      res.destroy();
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── UPLOAD FILE ───────────────────────────────────────────
const multer = require("multer");

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dest = req.query.path
      ? safePath(req.query.path)
      : path.resolve(MEDIA_DIR);

    if (!dest) return cb(new Error("Akses ditolak"));
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const originalName = Buffer.from(file.originalname, "latin1").toString("utf8");
    cb(null, originalName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 * 1024 }, // max 50 GB
});

app.post("/api/files/upload", upload.array("files"), (req, res) => {
  try {
    const uploaded = req.files.map((f) => ({
      name: f.filename,
      size: f.size,
      path: f.path,
    }));
    res.json({ success: true, uploaded });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RENAME FILE/FOLDER ────────────────────────────────────
app.patch("/api/files/rename", (req, res) => {
  try {
    const { oldPath, newName } = req.body;
    if (!oldPath || !newName) {
      return res.status(400).json({ error: "oldPath dan newName diperlukan" });
    }

    const resolvedOld = safePath(oldPath); // ← fix: pakai safePath
    if (!resolvedOld) return res.status(403).json({ error: "Akses ditolak" });
    if (!fs.existsSync(resolvedOld)) return res.status(404).json({ error: "File tidak ditemukan" });

    if (newName.includes("/") || newName.includes("\\") || newName.includes("..")) {
      return res.status(400).json({ error: "Nama tidak valid" });
    }

    const dir = path.dirname(resolvedOld);
    const resolvedNew = path.join(dir, newName);

    fs.renameSync(resolvedOld, resolvedNew);
    res.json({ success: true, newPath: resolvedNew });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CREATE FOLDER ─────────────────────────────────────────
app.post("/api/files/mkdir", (req, res) => {
  try {
    const { dirPath } = req.body;
    if (!dirPath) return res.status(400).json({ error: "dirPath diperlukan" });

    const resolved = safePath(dirPath);
    if (!resolved) return res.status(403).json({ error: "Akses ditolak" });

    fs.mkdirSync(resolved, { recursive: true });
    res.json({ success: true, created: resolved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET ALL FILES ─────────────────────────────────────────
app.get("/api/files", (req, res) => {
  try {
    const entries = fs.readdirSync(MEDIA_DIR, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile())
      .map((e) => {
        const filePath = path.join(MEDIA_DIR, e.name);
        const stat = fs.statSync(filePath);
        const ext = path.extname(e.name).toLowerCase();
        const sizeBytes = stat.size;
        const sizeFormatted =
          sizeBytes >= 1024 ** 3
            ? (sizeBytes / 1024 ** 3).toFixed(2) + " GB"
            : sizeBytes >= 1024 ** 2
            ? (sizeBytes / 1024 ** 2).toFixed(1) + " MB"
            : (sizeBytes / 1024).toFixed(0) + " KB";

        return {
          name: e.name,
          ext,
          size: sizeFormatted,
          sizeBytes,
          modifiedAt: stat.mtime,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ files, total: files.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/resource", (req, res) => {
  try {
    const data = getResourceUsage();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => {
  try {
    const data = "Server is running and healthy";
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/films
app.get("/api/films", (req, res) => {
  try {
    if (!fs.existsSync(FILMS_PATH)) {
      return res.status(404).json({ error: "Folder film tidak ditemukan", path: FILMS_PATH });
    }

    const files = fs.readdirSync(FILMS_PATH);
    const films = files
      .filter((file) => SUPPORTED_FORMATS.includes(path.extname(file).toLowerCase()))
      .map((file) => {
        const { title, year } = parseFilmName(file);
        const filePath = path.join(FILMS_PATH, file);
        const stats = fs.statSync(filePath);
        const sizeGB = (stats.size / (1024 * 1024 * 1024)).toFixed(2);
        return {
          id: Buffer.from(file).toString("base64url"),
          filename: file,
          title,
          year,
          sizeGB,
          ext: path.extname(file).toLowerCase(),
        };
      });

    res.json({ films });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stream/:id
app.get("/api/stream/:id", (req, res) => {
  try {
    const filename = Buffer.from(req.params.id, "base64url").toString("utf-8");
    const filePath = path.join(FILMS_PATH, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File tidak ditemukan" });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    const contentType = mime.lookup(filePath) || "video/mp4";

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;
      const stream = fs.createReadStream(filePath, { start, end });

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": contentType,
      });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/subtitle/:id", async (req, res) => {
  try {
    const filename = Buffer.from(req.params.id, "base64url").toString("utf-8");
    const ext = path.extname(filename).toLowerCase();
    const baseName = path.basename(filename, ext);
    const srtPath = path.join(FILMS_PATH, `${baseName}.srt`);
    const vttPath = path.join(FILMS_PATH, `${baseName}.vtt`);

    // Kalau VTT cache sudah ada
    if (fs.existsSync(vttPath)) {
      res.setHeader("Content-Type", "text/vtt");
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.send(fs.readFileSync(vttPath, "utf-8"));
    }

    // Kalau SRT ada, convert ke VTT
    if (fs.existsSync(srtPath)) {
      const srtContent = fs.readFileSync(srtPath, "utf-8")
        .replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const vttContent = srtToVtt(srtContent);
      fs.writeFileSync(vttPath, vttContent, "utf-8");
      res.setHeader("Content-Type", "text/vtt");
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.send(vttContent);
    }

    return res.status(404).json({ error: "Subtitle tidak ditemukan" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`RumahFilm STB server running on port ${PORT}`);
  console.log(`Films path: ${FILMS_PATH}`);
});
