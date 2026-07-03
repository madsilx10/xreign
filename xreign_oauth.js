import fs from 'fs';
import readline from 'readline';
import crypto from 'crypto';

const BASE = 'https://api.xreign.app';
const X_REDIRECT_URI = `${BASE}/api/auth/x/callback`;

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const X_PUBLIC_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

// Parse accounts.txt (format: auth_token\nct0\nauth_token\nct0\n...)
function parseAccounts() {
  const lines = fs.readFileSync('accounts.txt', 'utf-8').split('\n').map(l => l.trim()).filter(Boolean);
  const accounts = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    accounts.push({ auth_token: lines[i], ct0: lines[i + 1] });
  }
  return accounts;
}

// Helper X API request (pakai bearer + cookie)
async function xRequest(method, url, { auth_token, ct0 }, opts = {}) {
  const headers = {
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
  };
  return fetch(url, { method, headers, body: opts.body, redirect: opts.redirect || 'follow' });
}

// Connect X OAuth untuk xreign
async function connectX(account) {
  const { auth_token, ct0 } = account;

  // Step 1: Minta authUrl dari backend xreign
  // Backend yang generate state + PKCE, bukan kita
  const step1Res = await fetch(`${BASE}/api/auth/x`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' },
    redirect: 'manual',
  });

  // Ambil Set-Cookie dari step1 (dipakai di step4)
  const setCookies = step1Res.headers.getSetCookie ? step1Res.headers.getSetCookie() : [];
  const sessionCookie = setCookies.map(c => c.split(';')[0]).join('; ');

  // authUrl ada di Location header (302 redirect)
  const authorizeUrl = step1Res.headers.get('location');
  console.log('  [Step1] Status: ' + step1Res.status + ', authUrl: ' + (authorizeUrl || 'null'));
  if (!authorizeUrl) throw new Error('Step1: tidak ada Location header di response');
  const authorizeUrlObj = new URL(authorizeUrl);
  const state = authorizeUrlObj.searchParams.get('state');

  // Step 2: GET ke api.x.com (bukan x.com/i/api) untuk dapet auth_code
  const apiAuthorizeUrl = authorizeUrl.replace('https://x.com/i/oauth2/authorize', 'https://api.x.com/2/oauth2/authorize');
  const step2 = await xRequest('GET', apiAuthorizeUrl, { auth_token, ct0 });
  const step2Text = await step2.text();
  console.log(`  [Step2] Status: ${step2.status}, Body: ${step2Text.substring(0, 200)}`);

  let approvalCode;
  try {
    const j = JSON.parse(step2Text);
    approvalCode = j.auth_code;
  } catch {
    const m = step2Text.match(/"auth_code"\s*:\s*"([^"]+)"/);
    if (m) approvalCode = m[1];
  }
  if (!approvalCode) throw new Error(`Gagal ambil auth_code (status ${step2.status})`);

  // Step 3: POST approve consent
  const step3 = await xRequest(
    'POST',
    'https://x.com/i/api/2/oauth2/authorize',
    { auth_token, ct0 },
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `approval=true&code=${encodeURIComponent(approvalCode)}`,
      redirect: 'manual',
    }
  );
  const step3Text = await step3.text();
  console.log(`  [Step3] Status: ${step3.status}, Body: ${step3Text.substring(0, 200)}`);

  let finalRedirect;
  try {
    const j = JSON.parse(step3Text);
    finalRedirect = j.redirect_uri;
  } catch {}

  // Fallback: ambil dari Location header kalau response-nya redirect
  if (!finalRedirect) {
    finalRedirect = step3.headers.get('location');
  }
  if (!finalRedirect) throw new Error('Gagal ambil redirect_uri dari step3');

  const finalUrl = new URL(finalRedirect);
  const finalCode = finalUrl.searchParams.get('code');
  const finalState = finalUrl.searchParams.get('state');

  if (!finalCode) throw new Error('Tidak ada code di redirect URL');

  // Step 4: GET ke callback URL xreign (endpoint yang dikasih di redirect_uri)
  const callbackUrl = `${BASE}/api/auth/x/callback?code=${encodeURIComponent(finalCode)}&state=${encodeURIComponent(finalState || state)}`;
  const step4Res = await fetch(callbackUrl, {
    method: 'GET',
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://xreign.app',
      'Referer': `https://xreign.app/`,
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    },
    redirect: 'manual',
  });
  const step4Text = await step4Res.text();
  console.log(`  [Step4] Status: ${step4Res.status}, URL: ${step4Res.url}`);
  console.log(`  [Step4] Headers: ${JSON.stringify(Object.fromEntries(step4Res.headers.entries())).substring(0, 400)}`);
  console.log(`  [Step4] Body: ${step4Text.substring(0, 200)}`);

  let step4Data;
  try {
    step4Data = JSON.parse(step4Text);
  } catch {
    const m = step4Text.match(/"(?:access_token|accessToken)"\s*:\s*"([^"]+)"/);
    if (m) step4Data = { accessToken: m[1] };
  }

  const accessToken = step4Data && (step4Data.accessToken || step4Data.access_token);
  if (!accessToken) throw new Error(`Step4: gagal ambil access_token. status=${step4Res.status}`);

  return accessToken;
}

// Helper prompt
function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

// Main
async function main() {
  const accounts = parseAccounts();
  console.log(`\n✓ Loaded ${accounts.length} accounts\n`);

  console.log('=== XREIGN X OAuth Connector ===');
  console.log('1. Satu akun');
  console.log('2. Semua akun');
  console.log('3. Range akun\n');
  const choice = await prompt('Pilihan (1/2/3): ');

  let targetIndices = [];
  if (choice === '1') {
    const idx = parseInt(await prompt(`Pilih akun (1-${accounts.length}): `)) - 1;
    targetIndices = [idx];
  } else if (choice === '2') {
    targetIndices = accounts.map((_, i) => i);
  } else if (choice === '3') {
    const from = parseInt(await prompt(`From (1-${accounts.length}): `)) - 1;
    const to = parseInt(await prompt(`To (1-${accounts.length}): `)) - 1;
    targetIndices = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  } else {
    console.log('Invalid choice'); process.exit(1);
  }

  console.log(`\n→ Processing ${targetIndices.length} account(s)\n`);

  for (const idx of targetIndices) {
    const account = accounts[idx];
    console.log(`[${idx + 1}/${accounts.length}] Connecting X...`);
    try {
      const token = await connectX(account);
      console.log(`  ✓ Connected! Token: ${token.slice(0, 20)}...\n`);
    } catch (err) {
      console.log(`  ✗ Error: ${err.message}\n`);
    }
  }

  console.log('Done!');
}

main();
