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
// 上から順に試す。先頭が使えない（提供終了・権限なし）ときは次に落ちる
const MODELS      = ['claude-sonnet-5-5', 'claude-haiku-4-5-20251001'];
const MAX_TOKENS  = 4000;
const MAX_RETRY   = 3;         // 混雑（429/529）時の再試行回数

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
    try {
      const { model, data } = await callWithFallback(prompt, env.ANTHROPIC_API_KEY);
      return json(data, 200, { ...cors, 'X-Used-Today': String(used + 1), 'X-Model': model });
    } catch (e) {
      return json({ error: e.userMessage || 'AIに接続できませんでした。時間をおいてお試しください' },
                  e.status || 502, cors);
    }
  },
};

// 1回だけ呼ぶ。拒否はHTTP 200で返ってくるので stop_reason を見る必要がある。
async function callOnce(model, prompt, apiKey) {
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (e) {
    throw Object.assign(new Error('network'), { status: 502, retryable: true });
  }

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const detail = data?.error?.message || '';
    const err = new Error(`status ${res.status}`);
    err.status = res.status;
    // 混雑・一時障害は待てば直る。キー不正やモデル未提供は待っても直らない
    err.retryable = [429, 500, 502, 503, 529].includes(res.status);
    err.modelUnavailable = [400, 403, 404].includes(res.status);
    err.userMessage =
        res.status === 401 ? 'サーバー側のAPIキーが無効です（管理者に連絡してください）'
      : res.status === 429 ? 'AIが混み合っています。少し待ってからお試しください'
      : /credit|balance/i.test(detail) ? 'AIの残高が不足しています（管理者に連絡してください）'
      : `AIの応答エラー（${res.status}）`;
    throw err;
  }

  // 安全分類器による拒否。エラーではなく200で返るので明示的に見る
  if (data?.stop_reason === 'refusal') {
    throw Object.assign(new Error('refusal'), { refused: true });
  }
  return data;
}

// 混雑なら待って再試行、モデルが使えないなら次のモデルへ
async function callWithFallback(prompt, apiKey) {
  let last;
  for (const model of MODELS) {
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      try {
        return { model, data: await callOnce(model, prompt, apiKey) };
      } catch (e) {
        last = e;
        if (e.retryable && attempt < MAX_RETRY) {
          await sleep(Math.min(800 * 2 ** attempt, 8000) + Math.random() * 400);
          continue;
        }
        break;   // 再試行しても無駄 → 次のモデルを試すか、諦める
      }
    }
    // 拒否またはモデル未提供なら次のモデル。それ以外は即座に返す
    if (!last?.refused && !last?.modelUnavailable) break;
  }
  if (last?.refused) {
    throw Object.assign(new Error('refused'),
      { status: 422, userMessage: 'この内容はお答えできませんでした。工事内容の書き方を変えてお試しください' });
  }
  throw last ?? new Error('unknown');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
