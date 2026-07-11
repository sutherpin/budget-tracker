// src/parser.js
// Parses Gesa Credit Union SMS transaction alerts into structured data.

/**
 * @typedef {Object} ParsedTransaction
 * @property {'purchase'|'payment'|'ignored'|'unknown'} transactionType
 * @property {number} amount
 * @property {string|null} merchant
 * @property {string|null} cardLast4
 * @property {string|null} occurredAt
 * @property {boolean} parsedSuccessfully
 */

const PURCHASE_PATTERN = /Pending charge for \$(?<amount>[\d,]+\.\d{2}) on (?<date>\d{2}\/\d{2}) (?<time>\d{2}:\d{2}) (?<tz>\w+) at (?<merchant>[^,]+),.*?ending in \*(?<last4>\d{4})/i;

const PAYMENT_PATTERN = /payment posted to your Credit card ending in \*(?<last4>\d{4}) for \$(?<amount>[\d,]+\.\d{2})/i;

const STATEMENT_PATTERN = /Your statement for/i;

export function parseGesaSms(smsBody) {
  const text = smsBody.trim();

  if (STATEMENT_PATTERN.test(text)) {
    return { transactionType: 'ignored', amount: 0, merchant: null,
             cardLast4: null, occurredAt: null, parsedSuccessfully: true };
  }

  const paymentMatch = text.match(PAYMENT_PATTERN);
  if (paymentMatch) {
    return {
      transactionType: 'payment',
      amount: parseFloat(paymentMatch.groups.amount.replace(/,/g, '')),
      merchant: null,
      cardLast4: paymentMatch.groups.last4,
      occurredAt: new Date().toISOString(),
      parsedSuccessfully: true,
    };
  }

  const purchaseMatch = text.match(PURCHASE_PATTERN);
  if (purchaseMatch) {
    const { amount, date, time, merchant, last4 } = purchaseMatch.groups;
    const year = new Date().getFullYear();
    const [month, day] = date.split('/');
    const occurredAt = `${year}-${month}-${day}T${time}:00`;
    return {
      transactionType: 'purchase',
      amount: parseFloat(amount.replace(/,/g, '')),
      merchant: cleanMerchantName(merchant),
      cardLast4: last4,
      occurredAt,
      parsedSuccessfully: true,
    };
  }

  return {
    transactionType: 'unknown',
    amount: extractAnyDollarAmount(text),
    merchant: null,
    cardLast4: null,
    occurredAt: new Date().toISOString(),
    parsedSuccessfully: false,
  };
}

function extractAnyDollarAmount(text) {
  const match = text.match(/\$([\d,]+\.\d{2})/);
  return match ? parseFloat(match[1].replace(/,/g, '')) : 0;
}

function cleanMerchantName(raw) {
  return raw.trim().replace(/\s+/g, ' ');
}
