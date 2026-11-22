const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Mime, X-Name",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

let memoryRatings = [];

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
      return json({ ok: true });
    }

    if (path === "/generate" && request.method === "POST") {
      if (!key) return json({ error: { message: "Добавьте переменную GEMINI_API_KEY в настройки Netlify" } }, 500);
      const { model, body } = await request.json();
      const m = encodeURIComponent(model || "gemini-2.5-flash");
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      return json(await r.json(), r.status);
    }

    if (path === "/upload" && request.method === "POST") {
      if (!key) return json({ error: { message: "Добавьте переменную GEMINI_API_KEY в настройки Netlify" } }, 500);
      const mime = request.headers.get("X-Mime") || "application/octet-stream";
      const buf = await request.arrayBuffer();

      const start = await fetch(
        `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${key}`,
        {
          method: "POST",
          headers: {
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": String(buf.byteLength),
            "X-Goog-Upload-Header-Content-Type": mime,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ file: { display_name: "upload" } }),
        }
      );

      const uploadUrl = start.headers.get("x-goog-upload-url");
      if (!uploadUrl) return json({ error: { message: "Не удалось начать загрузку файла в Gemini" } }, 502);

      const fin = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "X-Goog-Upload-Offset": "0",
          "X-Goog-Upload-Command": "upload, finalize",
        },
        body: buf,
      });
      return json(await fin.json(), fin.status);
    }

    if (path === "/file" && request.method === "GET") {
      if (!key) return json({ error: { message: "Добавьте переменную GEMINI_API_KEY в настройки Netlify" } }, 500);
      const name = url.searchParams.get("name") || "";
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}?key=${key}`);
      return json(await r.json(), r.status);
    }

    if (path === "/whisper" && request.method === "POST") {
      if (!groqKey) return json({ error: { message: "Добавьте переменную GROQ_API_KEY в настройки Netlify" } }, 500);
      const mime = request.headers.get("X-Mime") || "audio/mpeg";
      const fname = decodeURIComponent(request.headers.get("X-Name") || "audio.mp3");
      const buf = await request.arrayBuffer();
      const fd = new FormData();
      fd.append("file", new Blob([buf], { type: mime }), fname);
      fd.append("model", "whisper-large-v3");
      fd.append("language", "ru");
      fd.append("response_format", "verbose_json");

      const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${groqKey}` },
        body: fd,
      });
      return json(await r.json(), r.status);
    }

    if (path === "/rating" && request.method === "POST") {
      const rec = await request.json();
      memoryRatings = [rec, ...memoryRatings.filter((x) => x.id !== rec.id)].slice(0, 500);
      return json({ ok: true });
    }

    if (path === "/ratings" && request.method === "GET") {
      return json(memoryRatings);
    }

    if (path === "/ratings.csv" && request.method === "GET") {
      const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const rows = [
        ["Дата", "Эксперт", "Тип", "Документ", "Нейросеть", "Модель", "Точность", "Полнота", "Контроль выдумок", "Полезность", "Комментарий"]
          .map(esc)
          .join(","),
        ...memoryRatings.map((x) => {
          const s = x.scores || {};
          return [x.ts, x.expert || "", x.mode || "", x.name || "", x.engine || "", x.model || "", s["Точность"] || "", s["Полнота"] || "", s["Контроль выдумок"] || "", s["Полезность"] || "", x.comment || ""]
            .map(esc)
            .join(",");
        }),
      ];
      return new Response("\uFEFF" + rows.join("\r\n"), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="ratings.csv"',
          ...CORS,
        },
      });
    }

    return json({ error: { message: "Not found" } }, 404);
  } catch (e) {
    return json({ error: { message: e.message || String(e) } }, 500);
  }
};
