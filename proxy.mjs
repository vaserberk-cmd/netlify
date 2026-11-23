// Прокси между сайтом и нейросетями. Ключи хранятся в переменных Netlify:
//   GEMINI_API_KEY — ключ Gemini (aistudio.google.com/apikey)
//   GROQ_API_KEY   — ключ Groq (console.groq.com/keys), нужен для Whisper, Qwen 3.8 и GPT-OSS
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Mime, X-Name, X-Model",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

const GROQ = "https://api.groq.com/openai/v1";
const WHISPER_MODELS = ["whisper-large-v3", "whisper-large-v3-turbo"];
const CHAT_MODELS = ["qwen/qwen3.8-27b", "qwen/qwen3.6-27b", "openai/gpt-oss-120b", "openai/gpt-oss-20b"];
const KEYS = ["Точность", "Полнота", "Контроль выдумок", "Полезность"];

// Оценки: пробуем постоянное хранилище Netlify Blobs, иначе держим в памяти функции
let memoryRatings = [];
let blobStore = null;
async function store() {
  if (blobStore !== null) return blobStore;
  try {
    const { getStore } = await import("@netlify/blobs");
    blobStore = getStore("ratings");
  } catch (e) {
    blobStore = false;
  }
  return blobStore;
}
async function loadRatings() {
  const s = await store();
  if (s) {
    try {
      return (await s.get("all", { type: "json" })) || [];
    } catch (e) {}
  }
  return memoryRatings;
}
async function saveRatings(all) {
  memoryRatings = all;
  const s = await store();
  if (s) {
    try {
      await s.setJSON("all", all);
    } catch (e) {}
  }
}

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/^(\/\.netlify\/functions\/proxy|\/api)/, "") || "/";
  const key = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;

  try {
    if (path === "/" && request.method === "GET") {
      return json({ ok: true, gemini: !!key, groq: !!groqKey });
    }

    if (path === "/generate" && request.method === "POST") {
      if (!key) return json({ error: { message: "Добавьте переменную GEMINI_API_KEY в настройки Netlify" } }, 500);
      const { model, body } = await request.json();
      if (!/^(gemini|gemma)-[\w.\-]+$/.test(model || "")) return json({ error: { message: "Недопустимая модель" } }, 400);
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${key}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      );
      return json(await r.json(), r.status);
    }

    if (path === "/upload" && request.method === "POST") {
      if (!key) return json({ error: { message: "Добавьте переменную GEMINI_API_KEY в настройки Netlify" } }, 500);
      const mime = request.headers.get("X-Mime") || "application/octet-stream";
      if (!/^(audio|video|image)\/[\w.+\-]+$/.test(mime)) return json({ error: { message: "Разрешены только аудио, видео и изображения" } }, 400);
      const buf = await request.arrayBuffer();

      const start = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${key}`, {
        method: "POST",
        headers: {
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(buf.byteLength),
          "X-Goog-Upload-Header-Content-Type": mime,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ file: { display_name: "upload" } }),
      });
      const uploadUrl = start.headers.get("x-goog-upload-url");
      if (!uploadUrl) return json({ error: { message: "Не удалось начать загрузку файла в Gemini" } }, 502);

      const fin = await fetch(uploadUrl, {
        method: "POST",
        headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
        body: buf,
      });
      return json(await fin.json(), fin.status);
    }

    if (path === "/file" && request.method === "GET") {
      if (!key) return json({ error: { message: "Добавьте переменную GEMINI_API_KEY в настройки Netlify" } }, 500);
      const name = url.searchParams.get("name") || "";
      if (!/^files\/[\w\-]+$/.test(name)) return json({ error: { message: "Недопустимое имя файла" } }, 400);
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}?key=${key}`);
      return json(await r.json(), r.status);
    }

    // Whisper на Groq: заголовок X-Model выбирает large-v3 или large-v3-turbo
    if (path === "/whisper" && request.method === "POST") {
      if (!groqKey) return json({ error: { message: "Добавьте переменную GROQ_API_KEY в настройки Netlify" } }, 500);
      const mime = request.headers.get("X-Mime") || "audio/mpeg";
      const fname = decodeURIComponent(request.headers.get("X-Name") || "audio.mp3");
      const model = WHISPER_MODELS.includes(request.headers.get("X-Model")) ? request.headers.get("X-Model") : "whisper-large-v3";
      const buf = await request.arrayBuffer();
      const fd = new FormData();
      fd.append("file", new Blob([buf], { type: mime }), fname);
      fd.append("model", model);
      fd.append("language", "ru");
      fd.append("response_format", "verbose_json");
      fd.append("temperature", "0");
      const r = await fetch(`${GROQ}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${groqKey}` },
        body: fd,
      });
      return json(await r.json(), r.status);
    }

    // Чат-модели Groq (Qwen 3.8, GPT-OSS): тело запроса как у OpenAI chat/completions
    if (path === "/groq" && request.method === "POST") {
      if (!groqKey) return json({ error: { message: "Добавьте переменную GROQ_API_KEY в настройки Netlify" } }, 500);
      const body = await request.json();
      if (!CHAT_MODELS.includes(body.model)) {
        return json({ error: { message: `Модель ${body.model} не разрешена. Доступны: ${CHAT_MODELS.join(", ")}` } }, 400);
      }
      body.stream = false;
      const r = await fetch(`${GROQ}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${groqKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return json(await r.json(), r.status);
    }

    if (path === "/rating" && request.method === "POST") {
      const r = await request.json();
      const id = String(r.id || "");
      if (!/^[\w\-]{4,60}$/.test(id)) return json({ error: { message: "Недопустимый id" } }, 400);
      const clip = (v, n) => String(v == null ? "" : v).slice(0, n);
      const scores = {};
      for (const k of KEYS) {
        const v = Number(r.scores && r.scores[k]);
        if (v >= 1 && v <= 5) scores[k] = v;
      }
      const rec = {
        id,
        ts: clip(r.ts, 40) || new Date().toISOString(),
        expert: clip(r.expert, 80),
        mode: clip(r.mode, 10),
        name: clip(r.name, 200),
        engine: clip(r.engine, 40),
        model: clip(r.model, 60),
        scores,
        comment: clip(r.comment, 2000),
      };
      const all = [rec, ...(await loadRatings()).filter((x) => x.id !== id)].slice(0, 3000);
      await saveRatings(all);
      return json({ ok: true, total: all.length });
    }

    if (path === "/ratings" && request.method === "GET") {
      return json(await loadRatings());
    }

    if (path === "/ratings.csv" && request.method === "GET") {
      const esc = (v) => {
        let t = String(v == null ? "" : v).replace(/\r?\n/g, " ");
        if (/^[=+\-@]/.test(t)) t = "'" + t;
        return `"${t.replace(/"/g, '""')}"`;
      };
      const head = ["Дата", "Эксперт", "Тип", "Документ", "Нейросеть", "Модель", ...KEYS, "Среднее", "Комментарий"];
      const rows = (await loadRatings()).map((x) => {
        const s = x.scores || {};
        const v = KEYS.map((k) => s[k]).filter(Boolean);
        return [x.ts, x.expert, x.mode, x.name, x.engine, x.model, ...KEYS.map((k) => s[k] || ""), v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : "", x.comment];
      });
      return new Response("\uFEFF" + [head, ...rows].map((r) => r.map(esc).join(";")).join("\r\n"), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="ocenki.csv"',
          ...CORS,
        },
      });
    }

    return json({ error: { message: "Not found" } }, 404);
  } catch (e) {
    return json({ error: { message: e.message || String(e) } }, 500);
  }
};
