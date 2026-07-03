import fs from 'fs';
import readline from 'readline';
import crypto from 'crypto';

const X_CLIENT_ID = 'SHIxWlFNNEFTZ2ZONmcyZS00dEI6MTpjaQ';
const X_REDIRECT_URI = 'https://api.xreign.app/api/auth/x/callback';
const X_SCOPES = 'users.read tweet.read offline.access';
const BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAANRILgAAAAAAnWzUejRCOuH5E6i8nZz4puTs%3D1Zy7tfk8LF81lUq16cHjhLTyJu4FA33AGWWjCpTnA';
const CODE_CHALLENGE_METHOD = 'S256';

// Generate random state
function generateState() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Generate PKCE code_verifier & code_challenge
function generatePKCE() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let verifier = '';
  for (let i = 0; i < 128; i++) {
    verifier += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  
  return { verifier, challenge };
}

// Parse accounts.txt
function parseAccounts() {
  const content = fs.readFileSync('accounts.txt', 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  
  const accounts = [];
  for (let i = 0; i < lines.length; i += 2) {
    if (i + 1 < lines.length) {
      accounts.push({
        auth_token: lines[i].trim(),
        ct0: lines[i + 1].trim()
      });
    }
  }
  return accounts;
}

// Step 1: GET authorize endpoint
async function getAuthCode(auth_token, ct0, pkce_challenge, state) {
  const params = new URLSearchParams({
    client_id: X_CLIENT_ID,
    code_challenge: pkce_challenge,
    code_challenge_method: CODE_CHALLENGE_METHOD,
    redirect_uri: X_REDIRECT_URI,
    response_type: 'code',
    scope: X_SCOPES,
    state: state
  });

  const response = await fetch(`https://x.com/i/api/2/oauth2/authorize?${params}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${BEARER_TOKEN}`,
      'Cookie': `auth_token=${auth_token}; ct0=${ct0};`,
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36'
    }
  });

  const text = await response.text();
  console.log(`  [Step1] Status: ${response.status}, Body: ${text.substring(0, 200)}`);
  
  try {
    const data = JSON.parse(text);
    return data.auth_code;
  } catch (e) {
    throw new Error(`Step 1 parse error: ${e.message}`);
  }
}

// Step 2: POST authorize (submit consent)
async function submitConsent(auth_token, ct0, auth_code, state) {
  const body = new URLSearchParams({
    approval: 'true',
    code: auth_code
  });

  const response = await fetch('https://x.com/i/api/2/oauth2/authorize', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BEARER_TOKEN}`,
      'Cookie': `auth_token=${auth_token}; ct0=${ct0};`,
      'X-Csrf-Token': ct0,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36'
    },
    body: body.toString(),
    redirect: 'manual'
  });

  // Extract Location header (redirect URL dengan final code)
  const location = response.headers.get('location');
  if (!location) throw new Error('No redirect location in response');

  const url = new URL(location);
  const final_code = url.searchParams.get('code');
  const return_state = url.searchParams.get('state');

  if (!final_code) throw new Error('No code in redirect');

  return { final_code, return_state };
}

// Step 3: Call xreign callback (auto terjadi, tapi bisa kita simulate)
async function callCallback(final_code, state) {
  const response = await fetch(
    `https://api.xreign.app/api/auth/x/callback?code=${final_code}&state=${state}`,
    { method: 'GET' }
  );

  return response.status === 200;
}

// Prompt untuk pilihan
async function getUserChoice() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    console.log('\n=== XREIGN X OAuth Connector ===');
    console.log('1. Satu akun');
    console.log('2. Semua akun');
    console.log('3. Range akun (from - to)\n');
    
    rl.question('Pilihan (1/2/3): ', answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Get account index
async function getAccountIndex(totalAccounts) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    rl.question(`Pilih akun (1-${totalAccounts}): `, answer => {
      rl.close();
      resolve(parseInt(answer) - 1);
    });
  });
}

// Get range
async function getRange(totalAccounts) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    rl.question(`From (1-${totalAccounts}): `, from => {
      rl.question(`To (1-${totalAccounts}): `, to => {
        rl.close();
        resolve([parseInt(from) - 1, parseInt(to) - 1]);
      });
    });
  });
}

// Main
async function main() {
  try {
    const accounts = parseAccounts();
    console.log(`\n✓ Loaded ${accounts.length} accounts\n`);

    const choice = await getUserChoice();
    let targetAccounts = [];

    if (choice === '1') {
      const idx = await getAccountIndex(accounts.length);
      targetAccounts = [accounts[idx]];
    } else if (choice === '2') {
      targetAccounts = accounts;
    } else if (choice === '3') {
      const [from, to] = await getRange(accounts.length);
      targetAccounts = accounts.slice(from, to + 1);
    } else {
      console.log('Invalid choice');
      process.exit(1);
    }

    console.log(`\n→ Processing ${targetAccounts.length} account(s)\n`);

    for (let i = 0; i < targetAccounts.length; i++) {
      const account = targetAccounts[i];
      const idx = accounts.indexOf(account) + 1;

      try {
        console.log(`[${idx}/${accounts.length}] Connecting X...`);

        const state = generateState();
        const { challenge, verifier } = await generatePKCE();

        // Step 1
        const auth_code = await getAuthCode(account.auth_token, account.ct0, challenge, state);
        console.log(`  ✓ Got auth_code`);

        // Step 2
        const { final_code, return_state } = await submitConsent(
          account.auth_token,
          account.ct0,
          auth_code,
          state
        );
        console.log(`  ✓ Got final code`);

        // Step 3
        const success = await callCallback(final_code, return_state);
        if (success) {
          console.log(`  ✓ Connected!\n`);
        } else {
          console.log(`  ✗ Callback failed\n`);
        }

      } catch (err) {
        console.log(`  ✗ Error: ${err.message}\n`);
      }
    }

    console.log('Done!');
  } catch (err) {
    console.error('Fatal error:', err.message);
    process.exit(1);
  }
}

main();
