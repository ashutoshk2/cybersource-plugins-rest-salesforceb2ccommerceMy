'use strict';

var Logger = require('dw/system/Logger');
var configObject = require('../../configuration/index');
var cybersourceRestApi = require('../../apiClient/index');
var Constants = require('../../apiClient/constants');

var auditLogger = Logger.getLogger('VisaAcceptance', 'refund');

/**
 * *
 * @param {*} transactionId capture id (the {id} the refund is issued against) *
 * @param {*} referenceInformationCode merchant order reference (order number) *
 * @param {*} total refund amount *
 * @param {*} currency currency code *
 * @returns {*} *
 */
function httpRefundPayment(transactionId, referenceInformationCode, total, currency) {
    var instance = new cybersourceRestApi.RefundApi(configObject);

    var clientReferenceInformation = new cybersourceRestApi.Ptsv2paymentsClientReferenceInformation();
    clientReferenceInformation.code = referenceInformationCode;
    clientReferenceInformation.applicationName = Constants.APPLICATION_NAME;
    clientReferenceInformation.applicationVersion = Constants.APPLICATION_VERSION;

    var partner = new cybersourceRestApi.Ptsv2paymentsClientReferenceInformationPartner();
    // PSID for this release is the existing partner solution id exposed on the config object.
    partner.solutionId = configObject.solutionId;
    clientReferenceInformation.partner = partner;

    var amountDetails = new cybersourceRestApi.Ptsv2paymentsidcapturesOrderInformationAmountDetails();
    amountDetails.totalAmount = total.toString();
    amountDetails.currency = currency.toUpperCase();

    var orderInformation = new cybersourceRestApi.Ptsv2paymentsidrefundsOrderInformation();
    orderInformation.amountDetails = amountDetails;

    var request = new cybersourceRestApi.RefundCaptureRequest();
    request.clientReferenceInformation = clientReferenceInformation;
    request.orderInformation = orderInformation;

    //  Provide ability to customize request object with a hook.
    var HookMgr = require('dw/system/HookMgr');
    if (HookMgr.hasHook('app.payment.modifyrequest')) {
        var modifiedServiceRequest = HookMgr.callHook('app.payment.modifyrequest', 'Refund', request);
        // eslint-disable-next-line no-undef
        if (!empty(modifiedServiceRequest)) {
            request = modifiedServiceRequest;
        }
    }

    var OrderMgr = require('dw/order/OrderMgr');
    var CardHelper = require('~/cartridge/scripts/helpers/CardHelper');
    var PaymentInstrumentUtils = require('~/cartridge/scripts/util/paymentInstrumentUtils');
    var order = OrderMgr.getOrder(referenceInformationCode);
    var paymentInstrument = order ? CardHelper.getNonGCPaymemtInstument(order) : null;

    // Audit log: refund attempt.
    auditLogger.info('[refund.js] Refund attempt: order {0}, capture {1}, amount {2} {3}',
        referenceInformationCode, transactionId, total, currency);

    // Cap: never refund more than the remaining refundable balance. When the captured
    // total is known on the order's payment transaction, reject an over-refund (full,
    // single partial, or the running total of multiple partials) before the gateway call.
    if (order && paymentInstrument && paymentInstrument.paymentTransaction) {
        var txnCustom = paymentInstrument.paymentTransaction.custom;
        var capturedTotal = txnCustom.AmountPaid || 0;
        var remainingRefundable = capturedTotal - (txnCustom.refundedAmount || 0);
        if (capturedTotal > 0 && Number(total) > remainingRefundable) {
            var capMsg = 'Refund amount (' + Number(total) + ') exceeds remaining refundable balance ('
                + remainingRefundable + ')';
            PaymentInstrumentUtils.RecordRefundFailure(paymentInstrument, order, capMsg);
            auditLogger.error('[refund.js] Refund REJECTED (over-refund): order {0}, {1}',
                referenceInformationCode, capMsg);
            throw new Error(capMsg);
        }
    }

    var result = '';
    // eslint-disable-next-line consistent-return
    instance.refundCapture(request, transactionId, function (data, error, response) { // eslint-disable-line no-unused-vars
        if (!error) {
            result = data;
            try {
                if (order && paymentInstrument) {
                    PaymentInstrumentUtils.UpdatePaymentTransactionRefund(paymentInstrument, order, result);
                }
                // Audit log: successful outcome.
                auditLogger.info('[refund.js] Refund outcome SUCCESS: order {0}, status {1}',
                    referenceInformationCode, result.status);
            } catch (e) {
                Logger.error('[refund.js] Error in httpRefundPayment request ( {0} )', e.message);
                return { error: true, errorMsg: e.message };
            }
        } else {
            if (order && paymentInstrument) {
                PaymentInstrumentUtils.RecordRefundFailure(paymentInstrument, order, JSON.stringify(data));
            }
            // Audit log: failed outcome.
            auditLogger.error('[refund.js] Refund outcome FAILED: order {0}, error {1}',
                referenceInformationCode, JSON.stringify(data));
            throw new Error(data);
        }
    });
    return result;
}

module.exports = {
    httpRefundPayment: httpRefundPayment
};
