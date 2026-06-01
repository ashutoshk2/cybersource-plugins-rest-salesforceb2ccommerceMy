'use strict';

var PaymentInstrument = require('dw/order/PaymentInstrument');
var Resource = require('dw/web/Resource');
var Transaction = require('dw/system/Transaction');
var Logger = require('dw/system/Logger');

/**
 * Create the BANK_TRANSFER (eCheck) payment instrument from the completeMandate
 * flow. Bank routing/account details are taken from the getPaymentDetails API
 * response that PlaceOrderDirect already fetched once and passed in via
 * paymentInformation.paymentDetails (avoids a duplicate API call).
 *
 * Authorization is performed client-side by the UC SDK; this hook only builds
 * the instrument.
 *
 * @param {dw.order.Basket} basket - Current basket
 * @param {Object} paymentInformation - { jwtPayload, transientToken, paymentMethod, paymentDetails, fromUC }
 * @returns {Object} { fieldErrors, serverErrors, error }
 */
function Handle(basket, paymentInformation) {
    var collections = require('*/cartridge/scripts/util/collections');
    var ucPaymentHelper = require('~/cartridge/scripts/helpers/ucPaymentHelper');
    var logger = Logger.getLogger('Cybersource', 'PaymentProcessor');
    var serverErrors = [];

    var paymentDetails = paymentInformation && paymentInformation.paymentDetails;
    if (!paymentDetails) {
        // Fallback: fetch once if caller didn't supply it (e.g. legacy callers).
        try {
            var payments = require('../../../http/payments');
            paymentDetails = payments.getPaymentDetails(paymentInformation.transientToken);
        } catch (e) {
            logger.error('bank_transfer.Handle: getPaymentDetails failed: {0}', e.message || e);
            serverErrors.push(Resource.msg('error.payment.token.missing', 'error', null));
            return {
                fieldErrors: {},
                serverErrors: serverErrors,
                error: true
            };
        }
    }

    try {
        Transaction.wrap(function () {
            basket.removeAllPaymentInstruments();

            var existing = basket.getPaymentInstruments(PaymentInstrument.METHOD_BANK_TRANSFER);
            collections.forEach(existing, function (item) {
                basket.removePaymentInstrument(item);
            });

            var paymentInstrument = basket.createPaymentInstrument(
                PaymentInstrument.METHOD_BANK_TRANSFER,
                basket.totalGrossPrice
            );

            var bank = ucPaymentHelper.extractBankDetails(paymentDetails, basket.billingAddress);
            if (bank.routingNumber) {
                paymentInstrument.setBankRoutingNumber(bank.routingNumber);
            }
            if (bank.accountNumber) {
                paymentInstrument.setBankAccountNumber(bank.accountNumber);
            }
            if (bank.accountHolder) {
                paymentInstrument.setBankAccountHolder(bank.accountHolder);
            }

            if (paymentInformation && paymentInformation.transientToken) {
                paymentInstrument.custom.UCToken = paymentInformation.transientToken;
            }
        });

        return {
            fieldErrors: {},
            serverErrors: serverErrors,
            error: false
        };
    } catch (e) {
        logger.error('bank_transfer.Handle error for basket {0}: {1}', basket.UUID, e.message || e);
        serverErrors.push(Resource.msg('error.payment.not.valid', 'checkout', null));
        return {
            fieldErrors: {},
            serverErrors: serverErrors,
            error: true
        };
    }
}

var ProcessorExport = {};
var configObject = require('~/cartridge/configuration/index.js');

if (configObject.cartridgeEnabled) {
    ProcessorExport.Handle = Handle;
}

module.exports = ProcessorExport;
