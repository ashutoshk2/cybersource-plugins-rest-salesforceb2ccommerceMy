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
        }
    });
}

/**
 * Update the order payment instrument when a refund response arrives.
 * Accumulates the refunded amount and derives the refund status (partial/full)
 * on the payment transaction, and records an order note for the refund.
 * @param {Object} paymentInstrument PI detail
 * @param {Object} order Order detail
 * @param {Object} responseObject response object
 */
function UpdatePaymentTransactionRefund(paymentInstrument, order, responseObject) {
    Transaction.wrap(function () {
        if (responseObject.status === 'PENDING') {
            var txnCustom = paymentInstrument.paymentTransaction.custom;
            var capturedTotal = txnCustom.AmountPaid || 0;
            var refundAmount = Number(responseObject.refundAmountDetails.refundAmount);
            var refundedAmount = (txnCustom.refundedAmount || 0) + refundAmount;

            txnCustom.refundedAmount = refundedAmount;
            txnCustom.remainingRefundable = capturedTotal - refundedAmount;
            txnCustom.refundStatus = refundedAmount >= capturedTotal ? 'full' : 'partial';

            if (txnCustom.refundStatus === 'full') {
                // eslint-disable-next-line no-param-reassign
                order.paymentStatus = 0;
            }

            order.addNote('Refund Processed',
                'Amount: ' + refundAmount + ' ' + order.currencyCode
                + ' | Total Refunded: ' + refundedAmount
                + ' | Remaining: ' + txnCustom.remainingRefundable
                + ' | Status: ' + txnCustom.refundStatus
            );
        }
    });
}

/**
 * Record a failed refund attempt for audit purposes.
 * Does not overwrite a successful refundStatus (partial/full).
 * @param {Object} paymentInstrument PI detail
 * @param {Object} order Order detail
 * @param {string} errorMsg Error message from the failed refund
 */
function RecordRefundFailure(paymentInstrument, order, errorMsg) {
    Transaction.wrap(function () {
        var currentStatus = paymentInstrument.paymentTransaction.custom.refundStatus;
        if (currentStatus !== 'partial' && currentStatus !== 'full') {
            // eslint-disable-next-line no-param-reassign
            paymentInstrument.paymentTransaction.custom.refundStatus = 'failed';
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
