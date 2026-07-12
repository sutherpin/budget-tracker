const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const config = new Configuration({
    basePath: PlaidEnvironments[process.env.PLAID_ENV],
    baseOptions: {
        headers: {
            'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
            'PLAID-SECRET': process.env.PLAID_SECRET,
        },
    },
});
const client = new PlaidApi(config);

app.post('/create_link_token', async (req, res) => {
    try {
        const response = await client.linkTokenCreate({
            user: { client_user_id: 'jason-test-user' },
            client_name: 'Budget Tracker Test',
            products: ['transactions'],
            country_codes: ['US'],
            language: 'en',
        });
        res.json(response.data);
    } catch (err) {
        console.error(err.response?.data || err);
        res.status(500).json(err.response?.data || { error: 'link_token_create_failed' });
    }
});

// One-off recovery: re-run Link in update mode for the existing Gesa item
// after it hit ITEM_LOGIN_REQUIRED. No exchange step needed afterward —
// update mode keeps the same access_token.
app.post('/create_update_link_token', async (req, res) => {
    try {
        const response = await client.linkTokenCreate({
            user: { client_user_id: 'jason-test-user' },
            client_name: 'Budget Tracker Test',
            country_codes: ['US'],
            language: 'en',
            access_token: process.env.GESA_ACCESS_TOKEN,
        });
        res.json(response.data);
    } catch (err) {
        console.error(err.response?.data || err);
        res.status(500).json(err.response?.data || { error: 'update_link_token_create_failed' });
    }
});

app.post('/exchange_token', async (req, res) => {
    try {
        const response = await client.itemPublicTokenExchange({
            public_token: req.body.public_token,
        });
        console.log('ACCESS TOKEN (save this):', response.data.access_token);
        console.log('ITEM ID:', response.data.item_id);
        res.json({ ok: true });
    } catch (err) {
        console.error(err.response?.data || err);
        res.status(500).json(err.response?.data || { error: 'exchange_failed' });
    }
});

app.listen(3000, () => console.log('http://localhost:3000'));
