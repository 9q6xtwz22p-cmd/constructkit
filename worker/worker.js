// まとめる現場 — AI見積もりの中継（Cloudflare Worker）
//
// なぜ必要か：APIキーをHTMLに書くと誰でも読めてしまうので、
// キーはここ（Workerの環境変数 ANTHROPIC_API_KEY）だけに置き、ブラウザには降ろさない。
// ブラウザ → このWorker → Anthropic API という流れになる。
//
// URLは公開されるので、残高を守るための歯止めを3つ入れてある：
//   1. 呼び出し元のOriginを限定
//   2. 1IPあたりの1日の回数制限（KV）
//   3. モデル・最大トークン・プロンプト長をサーバー側で固定（汎用プロキシとして使わせない）

const ALLOWED_ORIGINS = [
  'https://9q6xtwz22p-cmd.github.io',
  'null',                      // ローカルのindex.htmlを直接開いて試すとき
  'http://localhost:8000',
];
const DAILY_LIMIT = 50;        // 1IPあたり／日
const MAX_PROMPT  = 30000;     // 文字数。通常の見積依頼は6,000字程度
const MODEL       = 'claude-sonnet-5-5';
const MAX_TOKENS  = 4000;

const json = (obj, status, headers) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'content-type': 'application/json; charset=utf-8' }
  });

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Max-Age': '86400',
    };

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST')   return json({ error: 'POSTのみ受け付けます' }, 405, cors);
    if (!allowed)                return json({ error: 'このURLからは利用できません' }, 403, cors);
    if (!env.ANTHROPIC_API_KEY)  return json({ error: 'サーバー側のAPIキーが未設定です' }, 503, cors);

    // --- 本文
    let body;
    try { body = await req.json(); } catch (e) { return json({ error: 'リクエストが不正です' }, 400, cors); }
    const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
    if (!prompt)                   return json({ error: '依頼内容が空です' }, 400, cors);
    if (prompt.length > MAX_PROMPT) return json({ error: '依頼内容が長すぎます' }, 413, cors);

    // --- 1日の回数制限
    const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
    const day = new Date().toISOString().slice(0, 10);
    const rlKey = `rl:${day}:${ip}`;
    let used = 0;
    if (env.RL) {
      used = Number(await env.RL.get(rlKey)) || 0;
      if (used >= DAILY_LIMIT) {
        return json({ error: `本日の利用上限（${DAILY_LIMIT}回）に達しました。明日またお試しください` }, 429, cors);
      }
      await env.RL.put(rlKey, String(used + 1), { expirationTtl: 60 * 60 * 48 });
    }

    // --- Anthropicへ。モデルと上限はサーバー側で固定する
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    } catch (e) {
      return json({ error: 'AIに接続できませんでした。時間をおいてお試しください' }, 502, cors);
    }

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = data?.error?.message || '';
      // キーや残高の話はそのまま出さず、運用者向けの短い文言にする
      const msg = res.status === 401 ? 'サーバー側のAPIキーが無効です（管理者に連絡してください）'
                : res.status === 429 ? 'AIが混み合っています。少し待ってからお試しください'
                : /credit|balance/i.test(detail) ? 'AIの残高が不足しています（管理者に連絡してください）'
                : `AIの応答エラー（${res.status}）`;
      return json({ error: msg }, res.status, cors);
    }
    return json(data, 200, { ...cors, 'X-Used-Today': String(used + 1) });
  },
};
