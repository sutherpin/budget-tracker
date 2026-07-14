const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');

const app = express();
const PORT = 3001;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;

app.get('/', (req, res) => {
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/gmail.readonly');
  // access_type=offline + prompt=consent is required to get a refresh_token back —
  // Google only issues one on the first consent (or when prompt=consent forces a
  // fresh grant), not on every authorization.
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  res.send(`
    <p>Sign in with <strong>sutherwebreceipts@gmail.com</strong> when prompted.</p>
    <a href="${authUrl.toString()}">Authorize Gmail read access</a>
  `);
});

app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    res.status(400).send(`No code returned — Google said: ${req.query.error || 'unknown error'}`);
    return;
  }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.refresh_token) {
      console.error('No refresh_token in response:', tokens);
      res.status(500).send(
        'No refresh_token came back. This usually means the app already has a prior ' +
        'grant for this account without prompt=consent forcing a new one — revoke access ' +
        'at https://myaccount.google.com/permissions and try again.'
      );
      return;
    }
    console.log('ACCESS TOKEN:', tokens.access_token);
    console.log('REFRESH TOKEN (save this — this is the long-lived credential):', tokens.refresh_token);
    res.send('Success! Check this terminal for the refresh token.');
  } catch (err) {
    console.error('Token exchange failed:', err);
    res.status(500).send('Token exchange failed — check the server console.');
  }
});

app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
