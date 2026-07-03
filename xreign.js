import fs from 'fs';
import readline from 'readline';

const BASE = 'https://api.xreign.app';
const X_REDIRECT_URI = `${BASE}/api/auth/x/callback`;
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const X_PUBLIC_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const TOKENS_FILE = 'tokens.json';

// ─── Token Storage ───────────────────────────────────────────────────────────

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8')); } catch { return {}; }
}

function saveToken(idx, data) {
  const tokens = loadTokens();
  tokens[idx] = data;
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

// ─── Accounts ────────────────────────────────────────────────────────────────

function parseAccounts() {
  const raw = fs.readFileSync('accounts.txt', 'utf-8');
  const blocks = raw.split(/\r?\n\r?\n/).map(b => b.trim()).filter(Boolean);
  return blocks.map(b => {
    const lines = b.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    return { auth_token: lines[0], ct0: lines[1] };
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(q, a => { rl.close(); r(a.trim()); }));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function xReq(method, path, accessToken, body = null) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'User-Agent': UA,
      'Authorization': `Bearer ${accessToken}`,
      'Accept': '*/*',
      'Content-Type': 'application/json',
      'Origin': 'https://xreign.app',
      'Referer': 'https://xreign.app/',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, data: text }; }
}

async function xTwitterReq(method, url, account, opts = {}) {
  const { auth_token, ct0 } = account;
  return fetch(url, {
    method,
    headers: {
      'User-Agent': UA,
      'Cookie': `auth_token=${auth_token}; ct0=${ct0}`,
      'x-csrf-token': ct0,
      'Authorization': `Bearer ${X_PUBLIC_BEARER}`,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...opts.headers,
    },
    body: opts.body,
    redirect: opts.redirect || 'follow',
  });
}

// ─── Refresh Token ───────────────────────────────────────────────────────────

async function refreshAccessToken(refreshToken) {
  const res = await fetch(`${BASE}/api/auth/refresh`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      'Origin': 'https://xreign.app',
      'Referer': 'https://xreign.app/',
    },
    body: JSON.stringify({ refreshToken }),
  });
  const data = await res.json();
  if (!data.accessToken) throw new Error('Refresh token gagal');
  return data;
}

async function getValidToken(idx, tokenData) {
  // Coba pakai access token yang ada
  const test = await xReq('GET', '/api/me', tokenData.accessToken);
  if (test.status === 200) return tokenData.accessToken;

  // Expired, refresh dulu
  if (!tokenData.refreshToken) throw new Error('Tidak ada refreshToken, perlu connect ulang');
  console.log('  → Token expired, refreshing...');
  const newTokens = await refreshAccessToken(tokenData.refreshToken);
  saveToken(idx, { ...tokenData, accessToken: newTokens.accessToken, refreshToken: newTokens.refreshToken });
  return newTokens.accessToken;
}

// ─── Connect X OAuth ─────────────────────────────────────────────────────────

async function connectX(account) {
  const { auth_token, ct0 } = account;

  // Step 1: Ambil authUrl dari xreign backend
  const REF_CODE = '6YSTPQ5C';
  const step1 = await fetch(`${BASE}/api/auth/x?ref=${REF_CODE}`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Referer': `https://xreign.app/login?ref=${REF_CODE}` },
    redirect: 'manual',
  });
  const setCookies = step1.headers.getSetCookie ? step1.headers.getSetCookie() : [];
  const sessionCookie = setCookies.map(c => c.split(';')[0]).join('; ');
  const authorizeUrl = step1.headers.get('location');
  if (!authorizeUrl) throw new Error('Step1: tidak ada Location header');
  const state = new URL(authorizeUrl).searchParams.get('state');

  // Step 2: GET authorize ke api.x.com
  const apiUrl = authorizeUrl.replace('https://x.com/i/oauth2/authorize', 'https://api.x.com/2/oauth2/authorize');
  const step2 = await xTwitterReq('GET', apiUrl, { auth_token, ct0 });
  const step2Data = await step2.json();
  const authCode = step2Data.auth_code;
  if (!authCode) throw new Error(`Step2 gagal: ${JSON.stringify(step2Data).slice(0, 100)}`);

  // Step 3: POST approve consent
  const step3 = await xTwitterReq('POST', 'https://x.com/i/api/2/oauth2/authorize', { auth_token, ct0 }, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `approval=true&code=${encodeURIComponent(authCode)}`,
    redirect: 'manual',
  });
  const step3Data = await step3.json().catch(() => ({}));
  const redirectUri = step3Data.redirect_uri || step3.headers.get('location');
  if (!redirectUri) throw new Error('Step3: tidak ada redirect_uri');

  const redirectUrl = new URL(redirectUri);
  const finalCode = redirectUrl.searchParams.get('code');
  const finalState = redirectUrl.searchParams.get('state');
  if (!finalCode) throw new Error('Step3: tidak ada code di redirect URL');

  // Step 4: GET callback xreign
  const step4 = await fetch(`${BASE}/api/auth/x/callback?code=${encodeURIComponent(finalCode)}&state=${encodeURIComponent(finalState || state)}`, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://xreign.app',
      'Referer': 'https://xreign.app/',
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    },
    redirect: 'manual',
  });
  const loc4 = step4.headers.get('location');
  if (!loc4) throw new Error('Step4: tidak ada Location header');
  const exchangeCode = new URL(loc4, BASE).searchParams.get('code');
  if (!exchangeCode) throw new Error('Step4: tidak ada code di redirect URL');

  // Step 5: Complete OAuth, dapet accessToken + refreshToken
  const step5 = await fetch(`${BASE}/api/auth/oauth/complete`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      'Origin': 'https://xreign.app',
      'Referer': 'https://xreign.app/',
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    },
    body: JSON.stringify({ code: exchangeCode, referralCode: REF_CODE }),
  });
  const step5Data = await step5.json();
  if (!step5Data.accessToken) throw new Error(`Step5 gagal: ${JSON.stringify(step5Data).slice(0, 100)}`);

  return { accessToken: step5Data.accessToken, refreshToken: step5Data.refreshToken, userId: step5Data.userId };
}

// ─── Follow X ────────────────────────────────────────────────────────────────

async function followUser(account, targetHandle) {
  // Ambil userId dari handle dulu
  const lookupRes = await xTwitterReq('GET',
    `https://api.x.com/1.1/users/show.json?screen_name=${targetHandle}`,
    account
  );
  const lookupText = await lookupRes.text();
  console.log(`  [debug lookup] status=${lookupRes.status} body=${lookupText.slice(0,300)}`);
  if (lookupText.trim().startsWith('<')) throw new Error(`lookup return HTML (status: ${lookupRes.status})`);
  const userData = JSON.parse(lookupText);
  if (!userData.id_str) throw new Error(`Gagal lookup user @${targetHandle}: ${JSON.stringify(userData).slice(0,80)}`);

  // Follow
  const followRes = await xTwitterReq('POST',
    'https://api.x.com/1.1/friendships/create.json',
    account,
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `user_id=${userData.id_str}&follow=true`,
    }
  );
  const followText = await followRes.text();
  if (followText.trim().startsWith('<')) throw new Error(`Token X invalid/expired saat follow (status: ${followRes.status})`);
  const followData = JSON.parse(followText);
  const alreadyFollowing = followData.errors?.[0]?.code === 327;
  return followData.following || alreadyFollowing || followData.relationship?.source?.following;
}



// ─── Like & Repost ───────────────────────────────────────────────────────────

async function likeTweet(account, tweetUrl) {
  const tweetId = tweetUrl.split('/status/')[1]?.split('?')[0];
  if (!tweetId) throw new Error('Invalid tweet URL');

  const res = await xTwitterReq('POST',
    'https://api.x.com/1.1/favorites/create.json',
    account,
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `id=${tweetId}`,
    }
  );
  return res.status === 200 || res.status === 403; // 403 = already liked
}

async function retweetTweet(account, tweetUrl) {
  const tweetId = tweetUrl.split('/status/')[1]?.split('?')[0];
  if (!tweetId) throw new Error('Invalid tweet URL');

  const res = await xTwitterReq('POST',
    `https://api.x.com/1.1/statuses/retweet/${tweetId}.json`,
    account,
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `id=${tweetId}`,
    }
  );
  return res.status === 200 || res.status === 403; // 403 = already retweeted
}

// ─── Xreign API ──────────────────────────────────────────────────────────────

async function getDaily(token) {
  return xReq('GET', '/api/me/daily', token);
}

async function claimDaily(token) {
  return xReq('POST', '/api/me/daily', token, {});
}

async function followUnlock(token) {
  return xReq('POST', '/api/me/follow-unlock', token, {});
}

async function getTasks(token) {
  return xReq('GET', '/api/tasks', token);
}

async function startTask(token, taskId) {
  return xReq('POST', `/api/tasks/${taskId}/start`, token, {});
}

async function verifyTask(token, taskId) {
  return xReq('POST', `/api/tasks/${taskId}/verify`, token, {});
}

async function claimTask(token, taskId) {
  return xReq('POST', `/api/tasks/${taskId}/claim`, token, {});
}

async function getWheelStatus(token) {
  return xReq('GET', '/api/wheel/status', token);
}

async function spinWheel(token, mode) {
  return xReq('POST', '/api/wheel/spin', token, { mode });
}

async function getWheel(token) {
  return xReq('GET', '/api/wheel', token);
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function doDaily(token, label) {
  const daily = await getDaily(token);
  if (daily.data?.checkIn?.claimedToday) {
    console.log(`  [Daily] Sudah claim hari ini`);
    return;
  }
  const res = await claimDaily(token);
  if (res.status === 200 || res.status === 201) {
    console.log(`  [Daily] ✓ Claimed!`);
  } else {
    console.log(`  [Daily] ✗ Gagal: ${JSON.stringify(res.data).slice(0, 100)}`);
  }
}

async function doSpin(token) {
  const daily = await getDaily(token);
  const wheelReady = daily.data?.wheelReady;

  if (wheelReady) {
    const res = await spinWheel(token, 'daily');
    if (res.status === 200 || res.status === 201) {
      const reward = res.data?.reward;
      console.log(`  [Spin Daily] ✓ ${reward?.type} ${reward?.amount}`);
    } else {
      console.log(`  [Spin Daily] ✗ ${JSON.stringify(res.data).slice(0, 100)}`);
    }
  } else {
    console.log(`  [Spin Daily] Sudah spin hari ini`);
  }

  // Spin pake tiket kalau ada
  const wheel = await getWheel(token);
  // cek spin tickets dari balances
  const balRes = await xReq('GET', '/api/me/balances', token);
  const spinTickets = balRes.data?.balances?.find(b => b.type === 'SPIN_TICKET')?.amount || 0;

  if (parseInt(spinTickets) > 0) {
    console.log(`  [Spin Tiket] Ada ${spinTickets} tiket`);
    for (let i = 0; i < parseInt(spinTickets); i++) {
      const res = await spinWheel(token, 'ticket');
      if (res.status === 200 || res.status === 201) {
        const reward = res.data?.reward;
        console.log(`  [Spin Tiket ${i+1}] ✓ ${reward?.type} ${reward?.amount}`);
      } else {
        console.log(`  [Spin Tiket ${i+1}] ✗ ${JSON.stringify(res.data).slice(0, 100)}`);
        break;
      }
      await sleep(1000);
    }
  } else {
    console.log(`  [Spin Tiket] Tidak ada tiket`);
  }
}

async function doTasks(token, account) {
  const res = await getTasks(token);
  const tasks = res.data?.items || [];
  const available = tasks.filter(t => t.isAvailable && (!t.userCompletion || t.userCompletion?.status !== 'CLAIMED'));

  if (available.length === 0) {
    console.log(`  [Task] Semua task sudah selesai`);
    return;
  }

  for (const task of available) {
    const title = task.title;
    const taskId = task.id;
    const vtype = task.verification?.type;

    try {
      // Kalau task follow, follow dulu via X API
      if (vtype === 'x_follow' && account) {
        const handle = task.verification?.config?.xTargetHandle;
        if (handle) {
          await followUser(account, handle).catch(() => {});
          console.log(`  [Task] Follow @${handle} ✓`);
          await sleep(1500);
        }
      }

      // Kalau task engagement, like & repost dulu
      if (vtype === 'x_engagement' && account) {
        const postUrl = task.verification?.config?.xPostUrl;
        if (postUrl) {
          await likeTweet(account, postUrl).catch(() => {});
          await retweetTweet(account, postUrl).catch(() => {});
          await sleep(1500);
        }
      }

      // Start
      await startTask(token, taskId);
      await sleep(500);

      // Verify
      const vRes = await verifyTask(token, taskId);
      if (!vRes.data?.verification?.verified) {
        console.log(`  [Task] "${title}" verify gagal`);
        continue;
      }
      await sleep(500);

      // Claim
      const cRes = await claimTask(token, taskId);
      if (cRes.status === 200 || cRes.status === 201) {
        const amount = cRes.data?.ledger?.[0]?.amount;
        const type = cRes.data?.ledger?.[0]?.rewardType;
        console.log(`  [Task] ✓ "${title}" → +${amount} ${type}`);
      } else {
        console.log(`  [Task] "${title}" claim gagal: ${JSON.stringify(cRes.data).slice(0, 80)}`);
      }

      await sleep(1000);
    } catch (err) {
      console.log(`  [Task] "${title}" error: ${err.message}`);
    }
  }
}

async function doFollowUnlock(token) {
  const res = await followUnlock(token);
  if (res.data?.followGate?.unlocked) {
    console.log(`  [Follow Unlock] ✓ Spin gate unlocked`);
  } else {
    console.log(`  [Follow Unlock] ${JSON.stringify(res.data).slice(0, 80)}`);
  }
}

// ─── Mode Full ───────────────────────────────────────────────────────────────

async function runFull(idx, account, tokens) {
  console.log(`\n  === FULL MODE ===`);

  let tokenData = tokens[idx];

  // Connect X kalau belum ada token
  if (!tokenData?.accessToken) {
    console.log(`  [Connect] Menghubungkan X...`);
    try {
      const result = await connectX(account);
      tokenData = result;
      saveToken(idx, tokenData);
      console.log(`  [Connect] ✓ Connected! userId: ${result.userId}`);
    } catch (err) {
      console.log(`  [Connect] ✗ ${err.message}`);
      return;
    }
  } else {
    console.log(`  [Connect] Sudah terhubung, skip`);
  }

  const token = await getValidToken(idx, tokenData).catch(e => { console.log(`  Token error: ${e.message}`); return null; });
  if (!token) return;

  // Follow X (xreign_app & orvexhub) kalau belum
  console.log(`  [Follow X] Mengecek follow status...`);
  for (const handle of ['xreign_app', 'orvexhub']) {
    try {
      const followed = await followUser(account, handle);
      if (followed) {
        console.log(`  [Follow X] ✓ @${handle} followed (atau sudah follow)`);
      } else {
        console.log(`  [Follow X] @${handle} follow mungkin gagal, lanjut`);
      }
      await sleep(1500);
    } catch (e) {
      console.log(`  [Follow X] @${handle} error: ${e.message}`);
    }
  }

  // Follow unlock
  await doFollowUnlock(token);

  // Daily
  await doDaily(token);

  // Tasks
  await doTasks(token, account);

  // Spin
  await doSpin(token);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const accounts = parseAccounts();
  const tokens = loadTokens();
  console.log(`\n✓ Loaded ${accounts.length} accounts\n`);

  console.log('=== XREIGN BOT ===');
  console.log('1. Full  (connect → follow → daily → task → spin)');
  console.log('2. Daily (daily + task)');
  console.log('3. Spin  (spin daily + tiket)\n');
  const mode = await prompt('Mode (1/2/3): ');

  console.log('\n1. Satu akun');
  console.log('2. Semua akun');
  console.log('3. Range akun\n');
  const scope = await prompt('Scope (1/2/3): ');

  let targetIndices = [];
  if (scope === '1') {
    const idx = parseInt(await prompt(`Pilih akun (1-${accounts.length}): `)) - 1;
    targetIndices = [idx];
  } else if (scope === '2') {
    targetIndices = accounts.map((_, i) => i);
  } else if (scope === '3') {
    const from = parseInt(await prompt(`From (1-${accounts.length}): `)) - 1;
    const to = parseInt(await prompt(`To (1-${accounts.length}): `)) - 1;
    targetIndices = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }

  console.log(`\n→ Processing ${targetIndices.length} account(s)\n`);

  for (const idx of targetIndices) {
    const account = accounts[idx];
    console.log(`\n[${idx + 1}/${accounts.length}] Akun #${idx + 1}`);

    try {
      if (mode === '1') {
        await runFull(idx, account, tokens);
      } else if (mode === '2') {
        let tokenData = tokens[idx];
        if (!tokenData?.accessToken) { console.log(`  Belum connect, skip`); continue; }
        const token = await getValidToken(idx, tokenData).catch(e => null);
        if (!token) { console.log(`  Token gagal`); continue; }
        await doDaily(token);
        await doTasks(token, account);
      } else if (mode === '3') {
        let tokenData = tokens[idx];
        if (!tokenData?.accessToken) { console.log(`  Belum connect, skip`); continue; }
        const token = await getValidToken(idx, tokenData).catch(e => null);
        if (!token) { console.log(`  Token gagal`); continue; }
        await doSpin(token);
      }
    } catch (err) {
      console.log(`  ✗ Error: ${err.message}`);
    }

    if (targetIndices.length > 1) await sleep(2000);
  }

  console.log('\nDone!');
}

main();
