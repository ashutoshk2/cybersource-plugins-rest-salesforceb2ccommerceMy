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

module.exports = {
    UpdatePaymentTransactionCardCapture: UpdatePaymentTransactionCardCapture,
    UpdatePaymentTransactionCardauthReversal: UpdatePaymentTransactionCardauthReversal
};
