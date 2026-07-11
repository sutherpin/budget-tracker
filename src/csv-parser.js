/**
 * CSV Transaction Parser
 *
 * Parses bank transaction CSV files and imports them into the database
 * with duplicate checking and current month filtering.
 */

// Parse a CSV line with proper handling of quoted fields
function parseCSVLine(line) {
  const values = [];
  let currentValue = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        // Escaped quote
        currentValue += '"';
        i++; // Skip next quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(currentValue.trim());
      currentValue = '';
    } else {
      currentValue += char;
    }
  }

  // Add the last value
  values.push(currentValue.trim());
  return values;
}

/**
 * Determine whether a transaction description represents a credit card payment
 * (i.e. money moving from this account to pay off a credit card balance).
 * These should never be counted as budget spending since the card's own
 * purchases are already tracked/categorized separately.
 * @param {string} description
 * @returns {boolean}
 */
function isCreditCardPaymentDescription(description) {
  const d = (description || '').toLowerCase();
  return (
    (d.includes('credit card') && d.includes('payment')) ||
    d.includes('creditcard payment') ||
    d.includes('card payment') ||
    d.includes('epayment') ||
    d.includes('e-payment') ||
    d.includes('autopay') ||
    d.includes('auto pay') ||
    d.includes('cardmember serv') ||
    d.includes('online pymt') ||
    d.includes('card pymt') ||
    (d.includes('payment to') && d.includes('card'))
  );
}

/**
 * Parse a transaction from CSV row
 * @param {Array} row - Parsed CSV row
 * @returns {Object} Transaction object
 */
function parseTransactionFromCSV(row) {
  // Expected format: "Date","Description","Comments","Check Number","Amount","Balance"
  if (row.length < 6) {
    return null;
  }

  const [dateStr, description, , , amountStr] = row;

  // Parse date from MM/DD/YYYY format
  const dateParts = dateStr.split('/');
  if (dateParts.length !== 3) {
    return null;
  }

  // Convert to YYYY-MM-DD format for ISO compatibility
  const month = dateParts[0].padStart(2, '0');
  const day = dateParts[1].padStart(2, '0');
  const year = dateParts[2];
  const occurredAt = `${year}-${month}-${day}T12:00:00`; // Add time component

  // Parse amount - remove $ and commas, handle negative values
  const amount = parseFloat(amountStr.replace(/[$,]/g, ''));
  if (isNaN(amount)) {
    return null;
  }

  // Use absolute value since amount field should be positive
  // Transaction type will be determined by the sign
  const absAmount = Math.abs(amount);
  let transactionType;

  // Credit card payments (paying off a credit card balance from this account) are
  // tracked separately from budget spending, so they should never be counted as a
  // 'purchase' regardless of which direction the amount moves.
  if (isCreditCardPaymentDescription(description)) {
    transactionType = 'payment';
  } else if (amount < 0) {
    // Negative amounts are always purchases
    transactionType = 'purchase';
  } else {
    // For positive amounts, use heuristic to determine if it's likely a deposit
    // Common deposit indicators: contains words like "DEPOSIT", "TRANSFER", "PAYROLL", etc.
    const descriptionLower = description.toLowerCase();
    const isLikelyDeposit = descriptionLower.includes('deposit') ||
                           descriptionLower.includes('transfer') ||
                           descriptionLower.includes('payroll') ||
                           descriptionLower.includes('direct deposit') ||
                           descriptionLower.includes('atm deposit') ||
                           descriptionLower.includes('mobile deposit') ||
                           descriptionLower.includes('salary') ||
                           descriptionLower.includes('interest') ||
                           descriptionLower.includes('credit') ||
                           descriptionLower.includes('payment');

    transactionType = isLikelyDeposit ? 'deposit' : 'purchase';
  }

  return {
    description: description || 'Unknown',
    amount: absAmount,
    merchant: description || 'Unknown',
    occurredAt,
    transactionType,
    rawData: row.join('|') // Use as deduplication key
  };
}

/**
 * Check if transaction is a potential duplicate
 * @param {Object} env - Environment with DB
 * @param {Object} transaction - Parsed transaction
 * @returns {Promise<Object>} Potential duplicate transaction or null
 */
async function findPotentialDuplicate(env, transaction) {
  // First check for exact match (same merchant, amount, and date)
  const exactMatch = await env.DB.prepare(
    `SELECT id, merchant, amount, occurred_at FROM transactions
    WHERE merchant = ?
    AND amount = ?
    AND strftime('%Y-%m-%d', occurred_at) = strftime('%Y-%m-%d', ?)`
  ).bind(
    transaction.merchant,
    transaction.amount,
    transaction.occurredAt
  ).first();

  if (exactMatch) {
    return exactMatch;
  }

  // If no exact match, check for same amount and 8+ character merchant name match (case insensitive)
  const partialMatches = await env.DB.prepare(
    `SELECT id, merchant, amount, occurred_at FROM transactions
    WHERE amount = ?
    AND LENGTH(merchant) >= 8`
  ).bind(transaction.amount).all();

  for (const potentialMatch of partialMatches.results) {
    const matchMerchant = potentialMatch.merchant.toLowerCase();
    const newMerchant = transaction.merchant.toLowerCase();

    // Check if there's an 8+ character sequence match between the merchant names
    for (let i = 0; i <= matchMerchant.length - 8; i++) {
      const substring = matchMerchant.substring(i, i + 8);
      if (newMerchant.includes(substring)) {
        return potentialMatch; // Found a potential duplicate
      }
    }
  }

  return null; // No potential duplicates found
}

/**
 * Check if transaction is from current month
 * @param {string} transactionDate - Transaction date in ISO format
 * @returns {boolean} True if transaction is from current month
 */
function isCurrentMonth(transactionDate) {
  const txnDate = new Date(transactionDate);
  const now = new Date();

  return txnDate.getFullYear() === now.getFullYear() &&
         txnDate.getMonth() === now.getMonth();
}

/**
 * Import transactions from CSV file
 * @param {Object} env - Environment with DB
 * @param {string} csvData - CSV file content
 * @param {boolean} autoResolveDuplicates - Whether to automatically skip duplicates or return them for user resolution
 * @param {Array} approvedTransactions - List of transactions approved for import (used when autoResolveDuplicates is false)
 * @returns {Promise<Object>} Import results
 */
async function importTransactionsFromCSV(env, csvData, autoResolveDuplicates = true, approvedTransactions = null) {
  const lines = csvData.split('\n').filter(line => line.trim() !== '');
  if (lines.length < 2) {
    return { success: false, error: 'CSV file must have at least header and one data row' };
  }

  // Skip header row
  const transactionLines = lines.slice(1);

  let importedCount = 0;
  let duplicateCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  const potentialDuplicates = [];
  const approvedTransactionIds = new Set(approvedTransactions?.map(t => t.rawData) || []);

  for (const line of transactionLines) {
    try {
      if (!line.trim()) continue;

      const row = parseCSVLine(line);
      const transaction = parseTransactionFromCSV(row);

      if (!transaction) {
        errorCount++;
        continue;
      }

      // Skip transactions that are not from current month
      if (!isCurrentMonth(transaction.occurredAt)) {
        skippedCount++;
        continue;
      }

      // Check for potential duplicates
      const potentialDuplicate = await findPotentialDuplicate(env, transaction);

      if (potentialDuplicate) {
        if (autoResolveDuplicates) {
          // Auto-import mode: skip duplicates and count them
          duplicateCount++;
          continue;
        } else {
          // Scan mode: collect duplicates for user resolution, don't count them yet
          potentialDuplicates.push({
            transaction,
            existingTransaction: potentialDuplicate
          });
          continue;
        }
      }

      // If we have approved transactions list, only import those
      if (!autoResolveDuplicates && approvedTransactions && approvedTransactions.length > 0) {
        if (!approvedTransactionIds.has(transaction.rawData)) {
          // This transaction was skipped by user, don't count it as duplicate
          continue;
        }
      }

      // Import the transaction
      const now = new Date().toISOString();

      // Check for merchant category suggestion
      let suggestedCategoryId = null;
      if (transaction.transactionType === 'purchase') {
        const suggestion = await env.DB.prepare(
          "SELECT category_id FROM merchant_category_map WHERE merchant = ?"
        ).bind(transaction.merchant).first();

        if (suggestion) {
          suggestedCategoryId = suggestion.category_id;
        }
      }

      // Deposits and credit card payments don't need manual categorization since
      // they don't affect budget spending (payments are tracked separately from
      // the card's own categorized purchases).
      const status = transaction.transactionType === 'deposit' ||
        transaction.transactionType === 'payment' ||
        suggestedCategoryId
        ? 'categorized'
        : 'pending';

      await env.DB.prepare(
        `INSERT INTO transactions
        (raw_sms, amount, merchant, card_last4, transaction_type, occurred_at, status, category_id, categorized_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        `CSV:${transaction.rawData}`,
        transaction.amount,
        transaction.merchant,
        null,
        transaction.transactionType,
        transaction.occurredAt,
        status,
        suggestedCategoryId,
        status === 'categorized' ? now : null
      ).run();

      importedCount++;

    } catch (error) {
      console.error('Error importing transaction:', error);
      errorCount++;
    }
  }

  // Return different results based on mode
  if (autoResolveDuplicates) {
    // Final import mode: return actual import results
    // Calculate total transactions processed (imported + duplicates + skipped)
    const totalTransactions = importedCount + duplicateCount + skippedCount;
    return {
      success: true,
      importedCount,
      duplicateCount,
      skippedCount,
      totalTransactions, // Add total transactions count
      errorCount,
      potentialDuplicates: [],
      message: `Import completed: ${importedCount} imported, ${duplicateCount} duplicates, ${skippedCount} not current month, ${errorCount} errors`
    };
  } else {
    // Scan mode: return potential duplicates for user resolution
    // Count total transactions in CSV (excluding header and invalid rows)
    const totalTransactions = transactionLines.length - errorCount;
    return {
      success: true,
      importedCount: 0, // No imports during scan
      duplicateCount: 0, // Don't count duplicates yet
      skippedCount,
      totalTransactions, // Add total transactions count
      errorCount,
      potentialDuplicates,
      message: `Scan completed: ${potentialDuplicates.length} potential duplicates found, ${skippedCount} not current month, ${errorCount} errors`
    };
  }
}

export { importTransactionsFromCSV };