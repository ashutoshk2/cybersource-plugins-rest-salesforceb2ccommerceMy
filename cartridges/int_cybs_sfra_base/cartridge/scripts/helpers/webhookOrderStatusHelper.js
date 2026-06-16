'use strict';

var Logger = require('dw/system/Logger');
var Transaction = require('dw/system/Transaction');
var Order = require('dw/order/Order');

var STATUS_AUTHORIZED = 'Authorized';
var STATUS_CAPTURED = 'Captured';
var STATUS_PARTIAL = 'Partially Captured';

/**
 * Whether the webhook indicates a capture has occurred.
 * payments product: a payments.capture.status.* event IS the signal.
 * DM/FM case-management: the detail object embeds a capture link (_embedded.capture).
 * UC: details.status is CAPTURED or PARTIAL_CAPTURED.
 * @param {string} eventType webhook event type
 * @param {Object} details normalized transaction detail object
 * @returns {boolean} true if a capture happened
 */
function hasCaptureSignal(eventType, details) {
    if (eventType && eventType.indexOf('payments.capture.status') === 0) {
        return true;
    }
    // DM/FM case-management notification embeds a capture link when a capture occurred in EBC.
    if (details && details._embedded && details._embedded.capture) {
        return true;
    }
    var status = details && details.status;
    return status === 'CAPTURED' || status === 'PARTIAL_CAPTURED';
}

/**
 * Read the dedupe ledger as a plain array.
 * @param {Object} paymentTransaction PaymentTransaction
 * @returns {Array<string>} processed capture transaction ids
 */
function getProcessedIds(paymentTransaction) {
    var raw = paymentTransaction.custom.capturedWebhookTxnIds;
    var arr = [];
    if (raw) {
        for (var i = 0; i < raw.length; i++) {
            arr.push(raw[i]);
        }
    }
    return arr;
}

/**
 * Apply the authorization-only outcome: mark Authorized / NOT_PAID,
 * never downgrading a more-final state.
 * @param {Object} order dw.order.Order
 * @param {Object} paymentTransaction PaymentTransaction
 * @returns {Object} { applied, status }
 */
function applyAuthorized(order, paymentTransaction) {
    var current = order.getPaymentStatus().getValue();
    if (current === Order.PAYMENT_STATUS_PAID || current === Order.PAYMENT_STATUS_PARTPAID) {
        return { applied: false, status: paymentTransaction.custom.cybsTransactionStatus };
    }
    Transaction.wrap(function () {
        paymentTransaction.custom.cybsTransactionStatus = STATUS_AUTHORIZED;
        order.setPaymentStatus(Order.PAYMENT_STATUS_NOTPAID);
    });
    return { applied: true, status: STATUS_AUTHORIZED };
}

/**
 * Apply a capture outcome: fetch the real captured amount, accumulate it,
 * and set Captured/PAID or Partially Captured/PART_PAID. Idempotent per
 * capture transaction id; ignores currency-mismatched fetches.
 * @param {Object} order dw.order.Order
 * @param {Object} paymentTransaction PaymentTransaction
 * @param {string} transactionId capture transaction id
 * @param {Function} fetchCapturedAmount (id) -> { capturedAmount, currency } | null
 * @returns {Object} { applied, status }
 */
function applyCapture(order, paymentTransaction, transactionId, fetchCapturedAmount) {
    var processed = getProcessedIds(paymentTransaction);
    if (transactionId && processed.indexOf(transactionId) !== -1) {
        return { applied: false, status: paymentTransaction.custom.cybsTransactionStatus };
    }

    var fetched = fetchCapturedAmount ? fetchCapturedAmount(transactionId) : null;
    if (!fetched || !fetched.capturedAmount) {
        Logger.error('webhookOrderStatusHelper: could not fetch captured amount for txn {0}', transactionId);
        return { applied: false, status: null };
    }

    var orderCurrency = order.getCurrencyCode();
    if (fetched.currency && orderCurrency && fetched.currency !== orderCurrency) {
        Logger.error('webhookOrderStatusHelper: currency mismatch for txn {0} ({1} vs {2})', transactionId, fetched.currency, orderCurrency);
        return { applied: false, status: null };
    }

    var orderTotal = order.getTotalGrossPrice().getValue();
    var outcome = {};
    Transaction.wrap(function () {
        var prevPaid = Number(paymentTransaction.custom.AmountPaid) || 0;
        var cumulative = prevPaid + Number(fetched.capturedAmount);
        paymentTransaction.custom.AmountPaid = cumulative;

        if (transactionId) {
            processed.push(transactionId);
            paymentTransaction.custom.capturedWebhookTxnIds = processed;
        }

        if (cumulative >= orderTotal) {
            paymentTransaction.custom.cybsTransactionStatus = STATUS_CAPTURED;
            order.setPaymentStatus(Order.PAYMENT_STATUS_PAID);
            outcome.status = STATUS_CAPTURED;
        } else {
            paymentTransaction.custom.cybsTransactionStatus = STATUS_PARTIAL;
            order.setPaymentStatus(Order.PAYMENT_STATUS_PARTPAID);
            outcome.status = STATUS_PARTIAL;
        }
    });
    outcome.applied = true;
    return outcome;
}

/**
 * Map a webhook transaction outcome onto the order + payment transaction.
 * @param {Object} params { eventType, details, transactionId, order, fetchCapturedAmount }
 * @returns {Object} { applied: boolean, status: string|null }
 */
function applyTransactionOutcome(params) {
    var order = params.order;
    var details = params.details || {};
    var CardHelper = require('*/cartridge/scripts/helpers/CardHelper');
    var paymentInstrument = CardHelper.getNonGCPaymemtInstument(order);
    if (!paymentInstrument) {
        Logger.error('webhookOrderStatusHelper: no payment instrument on order {0}', order.orderNo);
        return { applied: false, status: null };
    }
    var paymentTransaction = paymentInstrument.paymentTransaction;

    if (!hasCaptureSignal(params.eventType, details)) {
        return applyAuthorized(order, paymentTransaction);
    }
    return applyCapture(order, paymentTransaction, params.transactionId, params.fetchCapturedAmount);
}

/**
 * Normalize the various payload envelopes (UC transactionResult, payments array, flat) to a detail object.
 * @param {Object} payload decrypted webhook payload
 * @returns {Object} detail object (contains status, id, clientReferenceInformation)
 */
function extractDetails(payload) {
    if (payload.payload && payload.payload.transactionResult) {
        return payload.payload.transactionResult.details;
    }
    if (payload.payload && payload.payload.length) {
        return payload.payload[0].data;
    }
    return payload;
}

/**
 * Extract the event type from either the top-level or the first payload entry.
 * @param {Object} payload decrypted webhook payload
 * @returns {string|null} event type
 */
function extractEventType(payload) {
    return payload.eventType || (payload.payload && payload.payload[0] ? payload.payload[0].eventType : null);
}

/**
 * End-to-end webhook handling: extract ids, look up the order, apply the outcome.
 * Does NOT do HTTP/signature/MLE/staging — that stays in the controller.
 * @param {Object} payload decrypted webhook payload
 * @param {Function} fetchCapturedAmount captured-amount fetcher (transactionDetails.getCapturedAmount)
 * @returns {Object} { orderFound, orderId, applied?, status? }
 */
function handleWebhook(payload, fetchCapturedAmount) {
    var details = extractDetails(payload);
    var orderId = details && details.clientReferenceInformation ? details.clientReferenceInformation.code : null;
    if (!orderId) {
        throw new Error('Missing Order ID');
    }
    var OrderMgr = require('dw/order/OrderMgr');
    var order = OrderMgr.getOrder(orderId);
    if (!order) {
        return { orderFound: false, orderId: orderId };
    }
    var outcome = applyTransactionOutcome({
        eventType: extractEventType(payload),
        details: details,
        transactionId: details && details.id ? details.id : null,
        order: order,
        fetchCapturedAmount: fetchCapturedAmount
    });
    return { orderFound: true, orderId: orderId, applied: outcome.applied, status: outcome.status };
}

module.exports = {
    hasCaptureSignal: hasCaptureSignal,
    applyTransactionOutcome: applyTransactionOutcome,
    handleWebhook: handleWebhook
};
