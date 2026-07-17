/* eslint-disable no-param-reassign */

'use strict';

var Transaction = require('dw/system/Transaction');
/**
 * Update the order payment instrument when card capture response arrived.
 * @param {Object} paymentInstrument PI detail
 * @param {Object} order Order detail
 * @param {Object} responseObject response object
 */
function UpdatePaymentTransactionCardCapture(paymentInstrument, order, responseObject, capturedAmount, currency) {
    if (!responseObject || responseObject.status !== 'PENDING') {
        return;
    }
    // Delegate to the shared capture core so the BM capture form and the DM/FM webhook flow stay
    // synchronized: accumulate AmountPaid (never overwrite), track remaining-to-capture, record the
    // capture transaction id (idempotent), set Captured/Partially Captured + paymentStatus, and note.
    // Prefer the KNOWN captured amount/currency passed by the caller (what was requested); fall back
    // to the response only if not provided, since the capture response may omit amountDetails.
    var amountDetails = responseObject.orderInformation && responseObject.orderInformation.amountDetails;
    var amount = (capturedAmount !== undefined && capturedAmount !== null && capturedAmount !== '')
        ? Number(capturedAmount.toString())
        : ((amountDetails && amountDetails.totalAmount !== undefined && amountDetails.totalAmount !== null)
            ? Number(amountDetails.totalAmount.toString())
            : 0);
    var captureCurrency = currency || (amountDetails ? amountDetails.currency : null);
    var statusHelper = require('*/cartridge/scripts/helpers/webhookOrderStatusHelper');
    statusHelper.applyCapturedAmount(order, paymentInstrument.paymentTransaction, responseObject.id, amount, captureCurrency);
}
/**
 *
 * @param {Object} paymentInstrument paymentInstrument
 * @param {Object} order order
 * @param {Object} responseObject responseObject
 */
function UpdatePaymentTransactionCardauthReversal(paymentInstrument, order, responseObject) {
    Transaction.wrap(function () {
        if (responseObject.status === 'REVERSED') {
            order.paymentStatus = 0;
            // Reflect the confirmed reversal in BM Orders-Payment "Visa Acceptance Transaction Status".
            // Keyed on the gateway-confirmed REVERSED response so it is only set when the reversal
            // actually succeeded; a failed reversal leaves the prior status intact.
            if (paymentInstrument && paymentInstrument.paymentTransaction) {
                paymentInstrument.paymentTransaction.custom.cybsTransactionStatus = 'Reversed';
            }
        }
    });
}

var STATUS_REFUNDED = 'Refunded';
var STATUS_PARTIALLY_REFUNDED = 'Partially Refunded';
var STATUS_REFUND_FAILED = 'Refund Failed';

/**
 * Update the order payment instrument when a refund response arrives.
 * Records the refund transaction id (idempotent), accumulates the refunded amount, derives the
 * refund status onto cybsTransactionStatus (Refunded/Partially Refunded — the single transaction-
 * status attribute, shared with the capture flow), and adds an order note. Multiple partial
 * refunds each append their transaction id to refundTransactionIds.
 * @param {Object} paymentInstrument PI detail
 * @param {Object} order Order detail
 * @param {Object} responseObject response object
 */
function UpdatePaymentTransactionRefund(paymentInstrument, order, responseObject) {
    Transaction.wrap(function () {
        if (responseObject.status === 'PENDING') {
            var statusHelper = require('*/cartridge/scripts/helpers/webhookOrderStatusHelper');
            var txnCustom = paymentInstrument.paymentTransaction.custom;

            // Idempotency: a refund transaction id is applied at most once, so a replayed
            // response never double-counts refundedAmount (mirrors the capture ledger).
            var refundIds = statusHelper.parseIdList(txnCustom.refundTransactionIds);
            var refundId = responseObject.id;
            if (refundId && refundIds.indexOf(refundId) !== -1) {
                return;
            }

            // Round to cents at every step: without it, float accumulation across multiple
            // partial refunds drifts (e.g. 59.01 + 60 + 38.98 = 157.98999999999998), so
            // refundedAmount never equals capturedTotal, the remaining balance reads 2.84e-14,
            // and a fully-refunded order stays "Partially Refunded". Mirrors applyCapturedAmount.
            var round2 = statusHelper.round2;
            var capturedTotal = round2(txnCustom.AmountPaid || 0);
            var refundAmount = round2(Number(responseObject.refundAmountDetails.refundAmount));
            var refundedAmount = round2((txnCustom.refundedAmount || 0) + refundAmount);
            var remainingRefundable = round2(capturedTotal - refundedAmount);

            txnCustom.refundedAmount = refundedAmount;
            txnCustom.remainingRefundable = remainingRefundable;

            if (refundId) {
                refundIds.push(refundId);
                txnCustom.refundTransactionIds = refundIds.join(',');
            }

            var status = refundedAmount >= capturedTotal ? STATUS_REFUNDED : STATUS_PARTIALLY_REFUNDED;
            txnCustom.cybsTransactionStatus = status;

            if (status === STATUS_REFUNDED) {
                // eslint-disable-next-line no-param-reassign
                order.paymentStatus = 0;
            }

            order.addNote('Refund Processed',
                'Amount: ' + refundAmount + ' ' + order.currencyCode
                + ' | Total Refunded: ' + refundedAmount
                + ' | Remaining: ' + remainingRefundable
                + ' | Status: ' + status
                + ' | Refund Transaction ID: ' + (refundId || '')
            );
        }
    });
}

/**
 * Record a failed refund attempt for audit purposes.
 * Sets cybsTransactionStatus to 'Refund Failed' but never overwrites a successful refund
 * outcome (Refunded/Partially Refunded), so a failed retry can't mask a prior refund.
 * @param {Object} paymentInstrument PI detail
 * @param {Object} order Order detail
 * @param {string} errorMsg Error message from the failed refund
 */
function RecordRefundFailure(paymentInstrument, order, errorMsg) {
    Transaction.wrap(function () {
        var txnCustom = paymentInstrument.paymentTransaction.custom;
        var currentStatus = txnCustom.cybsTransactionStatus;
        if (currentStatus !== STATUS_REFUNDED && currentStatus !== STATUS_PARTIALLY_REFUNDED) {
            txnCustom.cybsTransactionStatus = STATUS_REFUND_FAILED;
        }
        order.addNote('Refund Failed', errorMsg || 'Unknown error');
    });
}

module.exports = {
    UpdatePaymentTransactionCardCapture: UpdatePaymentTransactionCardCapture,
    UpdatePaymentTransactionCardauthReversal: UpdatePaymentTransactionCardauthReversal,
    UpdatePaymentTransactionRefund: UpdatePaymentTransactionRefund,
    RecordRefundFailure: RecordRefundFailure
};
