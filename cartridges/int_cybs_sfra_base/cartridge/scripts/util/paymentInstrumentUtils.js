/* eslint-disable no-param-reassign */

'use strict';

var Transaction = require('dw/system/Transaction');
/**
 * Update the order payment instrument when card capture response arrived.
 * @param {Object} paymentInstrument PI detail
 * @param {Object} order Order detail
 * @param {Object} responseObject response object
 */
function UpdatePaymentTransactionCardCapture(paymentInstrument, order, responseObject) {
    Transaction.wrap(function () {
        if (responseObject.status === 'PENDING') {
            // eslint-disable-next-line no-param-reassign
            paymentInstrument.paymentTransaction.custom.AmountPaid = Number(responseObject.orderInformation.amountDetails.totalAmount.toString());
            // eslint-disable-next-line no-param-reassign
            order.paymentStatus = 2;
        }
    });
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
