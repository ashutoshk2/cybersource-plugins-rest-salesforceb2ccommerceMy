'use strict';

var Resource = require('dw/web/Resource');
var Transaction = require('dw/system/Transaction');
var OrderMgr = require('dw/order/OrderMgr');
var Logger = require('dw/system/Logger');

var configObject = require('~/cartridge/configuration/index.js');

/**
 * Decide whether the legacy (non-UC) Google Pay flow needs to run 3DS payer
 * authentication before authorization. Mirrors the gPay-specific branches that
 * used to live in payments_credit.js shouldApplyPayerAuthentication.
 *
 * @param {dw.order.PaymentInstrument} paymentInstrument
 * @returns {boolean}
 */
function shouldApplyPayerAuthenticationGPay(paymentInstrument) {
    if (empty(paymentInstrument)) return false;
    if (empty(paymentInstrument.custom.GooglePayEncryptedData)) return false;
    if (paymentInstrument.custom.isGooglePaycardHolderAuthenticated === true) return false;

    var payerAuthentication = require('~/cartridge/scripts/http/payerAuthentication');
    var threeDSMode = payerAuthentication.get3DSMode();
    var cardType = payerAuthentication.getCardType(paymentInstrument);

    if (threeDSMode.value === 'NO') return false;
    if (threeDSMode.value === 'DATA_ONLY_NO'
        && !(cardType === 'VISA' || cardType === 'MASTERCARD' || cardType === 'MAESTRO')) {
        return false;
    }
    return configObject.cartridgeEnabled;
}

/**
 * Build the DW_GOOGLE_PAY payment instrument from the completeMandate JWT.
 * Used by the new UC completeMandate flow via PlaceOrderDirect. Authorization
 * is performed client-side by the UC SDK; this hook only creates the
 * instrument and stores the transient token.
 *
 * @param {dw.order.Basket} basket - Current basket
 * @param {Object} paymentInformation - { jwtPayload, transientToken, paymentMethod, isDigitalWallet, fromUC }
 * @returns {Object} { fieldErrors, serverErrors, error }
 */
function Handle(basket, paymentInformation) {
    var collections = require('*/cartridge/scripts/util/collections');
    var ucPaymentHelper = require('~/cartridge/scripts/helpers/ucPaymentHelper');
    var serverErrors = [];

    try {
        Transaction.wrap(function () {
            basket.removeAllPaymentInstruments();

            var existing = basket.getPaymentInstruments('DW_GOOGLE_PAY');
            collections.forEach(existing, function (item) {
                basket.removePaymentInstrument(item);
            });

            var paymentInstrument = basket.createPaymentInstrument('DW_GOOGLE_PAY', basket.totalGrossPrice);

            if (basket.billingAddress && basket.billingAddress.fullName) {
                paymentInstrument.setCreditCardHolder(basket.billingAddress.fullName);
            }

            if (paymentInformation && paymentInformation.transientToken) {
                paymentInstrument.custom.UCToken = paymentInformation.transientToken;
            }

            var cardDetails = ucPaymentHelper.extractCardDetails(
                paymentInformation && paymentInformation.jwtPayload,
                paymentInformation && paymentInformation.transientToken,
                basket.billingAddress
            );
            ucPaymentHelper.updatePaymentInstrumentCardDetails(paymentInstrument, cardDetails, true);
        });

        return {
            fieldErrors: {},
            serverErrors: serverErrors,
            error: false
        };
    } catch (e) {
        Logger.getLogger('Cybersource', 'PaymentProcessor').error(
            'google_pay_uc.Handle error for basket {0}: {1}', basket.UUID, e.message || e
        );
        serverErrors.push(Resource.msg('error.payment.not.valid', 'checkout', null));
        return {
            fieldErrors: {},
            serverErrors: serverErrors,
            error: true
        };
    }
}

/**
 * Authorize a legacy (non-UC) Google Pay payment. Used by SFRA's PlaceOrder
 * route via handlePayments → app.payment.processor.payments_googlepay.Authorize.
 * The basket has GooglePayEncryptedData stamped on the payment instrument by
 * the SubmitPaymentGP / GetGooglePayToken routes; this hook authorizes that
 * encrypted payload via the standard CyberSource authorization API.
 *
 * For the UC completeMandate flow, authorization is already done by the SDK
 * and PlaceOrderDirect skips SFRA's handlePayments — this Authorize is not
 * called in that path.
 *
 * @param {number} orderNumber
 * @param {dw.order.PaymentInstrument} paymentInstrument
 * @param {dw.order.PaymentProcessor} paymentProcessor
 * @returns {Object} { fieldErrors, serverErrors, error, performPayerAuthSetup? }
 */
function Authorize(orderNumber, paymentInstrument, paymentProcessor) {
    var payments = require('../../../http/payments');
    var mapper = require('~/cartridge/scripts/util/mapper.js');
    var logger = Logger.getLogger('Cybersource', 'PaymentAuthorization');

    var serverErrors = [];
    var fieldErrors = {};
    var error = false;

    if (shouldApplyPayerAuthenticationGPay(paymentInstrument)) {
        Transaction.wrap(function () {
            paymentInstrument.paymentTransaction.setPaymentProcessor(paymentProcessor);
        });
        return {
            fieldErrors: fieldErrors,
            serverErrors: serverErrors,
            error: false,
            performPayerAuthSetup: true
        };
    }

    var order = OrderMgr.getOrder(orderNumber);
    var billingAddress = order.billingAddress;
    var shippingAddress = order.shipments[0].shippingAddress;
    var total = order.totalGrossPrice;
    var customerEmail = order.customerEmail;
    var currencyCode = order.currencyCode.toUpperCase();

    var card = {
        gPayToken: paymentInstrument.custom.GooglePayEncryptedData,
        cardType: paymentInstrument.creditCardType ? paymentInstrument.creditCardType.toLowerCase() : null
    };

    try {
        var lineItems = mapper.MapOrderLineItems(order.allLineItems, true);
        var result = payments.httpAuthorizeWithToken(
            card, customerEmail, orderNumber, total.value, currencyCode,
            billingAddress, shippingAddress, lineItems
        );

        Transaction.wrap(function () {
            // eslint-disable-next-line no-undef
            session.privacy.orderStatus = result.status;
            paymentInstrument.paymentTransaction.setTransactionID(result.id);
            paymentInstrument.paymentTransaction.setPaymentProcessor(paymentProcessor);
            paymentInstrument.paymentTransaction.custom.paymentDetails =
                paymentInstrument.maskedCreditCardNumber + ', ' + paymentInstrument.creditCardType;

            paymentInstrument.custom.GooglePayEncryptedData = null;
            paymentInstrument.custom.isGooglePaycardHolderAuthenticated = null;
        });
    } catch (e) {
        error = true;
        var errorData = {};
        if (typeof e === 'object' && e !== null) {
            if ('message' in e) errorData.message = e.message;
            if ('details' in e) errorData.details = e.details;
        }
        serverErrors.push(Resource.msg('error.technical', 'checkout', null));
        logger.error('Authorization error for order {0}: {1}', orderNumber, JSON.stringify(errorData));
    }

    return {
        fieldErrors: fieldErrors,
        serverErrors: serverErrors,
        error: error
    };
}

var ProcessorExport = {};
if (configObject.cartridgeEnabled) {
    ProcessorExport.Handle = Handle;
    ProcessorExport.Authorize = Authorize;
}

module.exports = ProcessorExport;
