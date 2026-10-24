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
const MAX_PROMPT  = 60000;     // 文字数。図面の文字データを載せると長くなる
const MAX_IMAGES  = 3;         // 1回に送れる図面の枚数
const MAX_IMG_B64 = 5_000_000; // 画像1枚のbase64長（約3.7MB）
// 上から順に試す。先頭が使えない（提供終了・権限なし）ときは次に落ちる
const MODELS      = ['claude-sonnet-5-5', 'claude-haiku-4-5-20251001'];
const MAX_TOKENS  = 8000;      // 図面の読み取りは室・注記・根拠を返すので長くなる
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
    // 管理者用の利用履歴。合言葉を知っている人だけ見られる
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/usage') return usagePage(url, env);
    if (req.method !== 'POST')   return json({ error: 'POSTのみ受け付けます' }, 405, cors);
    if (!allowed)                return json({ error: 'このURLからは利用できません' }, 403, cors);
    if (!env.ANTHROPIC_API_KEY)  return json({ error: 'サーバー側のAPIキーが未設定です' }, 503, cors);

    // --- 本文
    let body;
    try { body = await req.json(); } catch (e) { return json({ error: 'リクエストが不正です' }, 400, cors); }
    const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
    // 回答の書き出しを指定する（例: "{"）。前置きを挟ませず、いきなりJSONから書かせたいとき用。
    const prefill = typeof body?.prefill === 'string' ? body.prefill.slice(0, 200) : '';
    // 利用履歴用。何に使ったか・どの端末か。中身（工事内容や単価）は受け取らない。
    const kind = String(body?.kind || '').slice(0, 12) || 'ai';
    const dev  = String(body?.dev  || '').slice(0, 24) || '名前なし';
    if (!prompt)                   return json({ error: '依頼内容が空です' }, 400, cors);
    if (prompt.length > MAX_PROMPT) return json({ error: '依頼内容が長すぎます' }, 413, cors);

    // 図面（画像）。無ければ今までどおり文章だけ
    const images = Array.isArray(body?.images) ? body.images : [];
    if (images.length > MAX_IMAGES) {
      return json({ error: `図面は${MAX_IMAGES}枚までです` }, 400, cors);
    }
    for (const im of images) {
      if (typeof im?.data !== 'string' || !/^image\/(png|jpeg|webp|gif)$/.test(im?.media_type || '')) {
        return json({ error: '図面の形式が不正です（PNG・JPEGのみ）' }, 400, cors);
      }
      if (im.data.length > MAX_IMG_B64) {
        return json({ error: '図面の画像が大きすぎます。解像度を下げてお試しください' }, 413, cors);
      }
    }

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
    const t0 = Date.now();
    try {
      const { model, data } = await callWithFallback(prompt, env.ANTHROPIC_API_KEY, images, prefill);
      await logUse(env, { kind, dev, ok: 1, model, ms: Date.now() - t0,
                          inTok: data?.usage?.input_tokens || 0, outTok: data?.usage?.output_tokens || 0,
                          img: images.length });
      return json(data, 200, { ...cors, 'X-Used-Today': String(used + 1), 'X-Model': model });
    } catch (e) {
      await logUse(env, { kind, dev, ok: 0, ms: Date.now() - t0, img: images.length,
                          err: String(e.userMessage || e.message || '').slice(0, 60) });
      return json({ error: e.userMessage || 'AIに接続できませんでした。時間をおいてお試しください' },
                  e.status || 502, cors);
    }
  },
};

// 1回だけ呼ぶ。拒否はHTTP 200で返ってくるので stop_reason を見る必要がある。
async function callOnce(model, prompt, apiKey, images = [], prefill = '') {
  // 図面は本文より前に置く。先に見てから指示を読ませたほうが読み取りが安定する
  const content = images.length
    ? [...images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })),
       { type: 'text', text: prompt }]
    : prompt;
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
        messages: prefill
          ? [{ role: 'user', content }, { role: 'assistant', content: prefill }]
          : [{ role: 'user', content }],
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
async function callWithFallback(prompt, apiKey, images = [], prefill = '') {
  let last;
  for (const model of MODELS) {
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      try {
        return { model, data: await callOnce(model, prompt, apiKey, images, prefill) };
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

// ===== 利用履歴 =====
// 「いつ・どの端末が・何をしたか」だけを残す。工事内容や単価は一切サーバーに置かない。
// KVのメタデータに入れておくと、一覧を取るだけで中身まで読めるので読み取りが1回で済む。
const LOG_TTL = 60 * 60 * 24 * 90;   // 90日で自動的に消える

async function logUse(env, rec) {
  if (!env.RL) return;
  try {
    const key = `log:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
    await env.RL.put(key, '', { metadata: rec, expirationTtl: LOG_TTL });
  } catch (e) { /* 記録に失敗しても本体は止めない */ }
}

const KIND_LABEL = { ai: 'AI見積', plan: '図面読み取り', import: '見積の取り込み' };

async function usagePage(url, env) {
  const key = url.searchParams.get('key') || '';
  if (!env.ADMIN_KEY) {
    return html('<h1>利用履歴</h1><p>まだ見られません。Workerに <code>ADMIN_KEY</code> を設定してください。</p>', 503);
  }
  if (key !== env.ADMIN_KEY) {
    return html('<h1>利用履歴</h1><p>合言葉が違います。</p>', 403);
  }
  if (!env.RL) return html('<h1>利用履歴</h1><p>保存先が未設定です。</p>', 503);

  const rows = [];
  let cursor;
  do {
    const r = await env.RL.list({ prefix: 'log:', limit: 1000, cursor });
    r.keys.forEach(k => { if (k.metadata) rows.push({ t: Number(k.name.split(':')[1]) || 0, ...k.metadata }); });
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor && rows.length < 4000);
  rows.sort((a, b) => b.t - a.t);

  // 端末ごと・日ごとの集計
  const byDev = {}, byDay = {};
  let okN = 0, ngN = 0, inTok = 0, outTok = 0;
  rows.forEach(r => {
    const d = new Date(r.t + 9 * 3600e3).toISOString().slice(0, 10);   // 日本時間
    byDev[r.dev] = (byDev[r.dev] || 0) + 1;
    byDay[d] = (byDay[d] || 0) + 1;
    r.ok ? okN++ : ngN++;
    inTok += r.inTok || 0; outTok += r.outTok || 0;
  });
  // ざっくりの費用。Sonnet の入力$3/出力$15 per 1M トークン、1ドル150円で概算
  const yen = Math.round((inTok / 1e6 * 3 + outTok / 1e6 * 15) * 150);

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const jst = (t) => new Date(t + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16);
  const bar = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${v}</td></tr>`).join('');

  return html(`
<h1>まとめる現場 — 利用履歴</h1>
<p class="sub">直近90日。記録しているのは「いつ・どの端末が・何をしたか」だけで、工事内容や金額は含みません。</p>

<div class="cards">
  <div class="c"><b>${rows.length}</b><span>実行回数</span></div>
  <div class="c"><b>${Object.keys(byDev).length}</b><span>使った端末</span></div>
  <div class="c"><b>${okN}</b><span>成功</span></div>
  <div class="c"><b>${ngN}</b><span>失敗</span></div>
  <div class="c"><b>約${yen.toLocaleString()}円</b><span>概算の費用</span></div>
</div>

<div class="two">
  <div><h2>端末ごと</h2><table>${bar(byDev) || '<tr><td>まだありません</td></tr>'}</table></div>
  <div><h2>日ごと</h2><table>${bar(byDay) || '<tr><td>まだありません</td></tr>'}</table></div>
</div>

<h2>明細（新しい順・最大200件）</h2>
<table class="log">
  <tr><th>日時</th><th>端末</th><th>内容</th><th>結果</th><th>秒</th><th>図面</th><th>トークン</th></tr>
  ${rows.slice(0, 200).map(r => `<tr class="${r.ok ? '' : 'ng'}">
    <td>${jst(r.t)}</td><td>${esc(r.dev)}</td><td>${esc(KIND_LABEL[r.kind] || r.kind)}</td>
    <td>${r.ok ? '成功' : '失敗 ' + esc(r.err || '')}</td>
    <td class="n">${((r.ms || 0) / 1000).toFixed(1)}</td>
    <td class="n">${r.img || ''}</td>
    <td class="n">${r.inTok ? (r.inTok + '／' + r.outTok) : ''}</td></tr>`).join('')
    || '<tr><td colspan="7">まだありません</td></tr>'}
</table>`);
}

function html(body, status = 200) {
  return new Response(`<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>利用履歴</title><style>
*{box-sizing:border-box}
body{font-family:"Hiragino Sans","Noto Sans JP",sans-serif;background:#eceae4;color:#1c1a16;margin:0;padding:24px;line-height:1.7}
h1{font-size:22px;margin:0 0 4px} h2{font-size:15px;margin:22px 0 8px;border-left:4px solid #1c4f7c;padding-left:8px}
.sub{font-size:12.5px;color:#55514a;margin:0 0 18px}
.cards{display:flex;gap:10px;flex-wrap:wrap}
.c{background:#fdfdfc;border:1px solid #d8d4ca;border-radius:4px;padding:12px 16px;min-width:110px}
.c b{display:block;font-size:21px} .c span{font-size:11.5px;color:#55514a}
.two{display:flex;gap:16px;flex-wrap:wrap} .two>div{flex:1;min-width:240px}
table{width:100%;border-collapse:collapse;background:#fdfdfc;border:1px solid #d8d4ca;font-size:12.5px}
td,th{padding:6px 9px;border-bottom:1px solid #e6e2d9;text-align:left}
th{background:#f5f3ee;font-size:11.5px} .n{text-align:right}
.log tr.ng{background:#f7ebe9}
code{background:#f5f3ee;padding:1px 5px;border-radius:3px}
</style></head><body>${body}</body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
