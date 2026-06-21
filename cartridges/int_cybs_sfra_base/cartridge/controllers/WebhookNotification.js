var server = require('server');
var CustomObjectMgr = require('dw/object/CustomObjectMgr');
var Encoding = require('dw/crypto/Encoding');
var Mac = require('dw/crypto/Mac');
var Bytes = require('dw/util/Bytes');
var Transaction = require('dw/system/Transaction');
var Logger = require('dw/system/Logger');
var OrderMgr = require('dw/order/OrderMgr');
var configObject = require('*/cartridge/configuration/index');


/**
 * Modular decryption function using native platform APIs
 */
function decryptMLEPayload(jweString) {
    if (!jweString) return null;
    var JWE = require('dw/crypto/JWE');
    var KeyRef = require('dw/crypto/KeyRef');

    // Resolve the egress P12 alias from the cartridge configuration (site preference
    // VisaAcceptance_EgressCertificateAlias, surfaced as configObject.egressMleCertificateAlias).
    // The default lives in the site-preference default-value, so no default is hardcoded here.
    var alias = configObject.egressMleCertificateAlias;


    // Pin the JWE header before handing the payload to dw/crypto/JWE — defense-in-depth
    // against algorithm-confusion and a clearer error when a misrouted webhook arrives.
    var trimmed = jweString.trim();
    var headerB64 = trimmed.split('.')[0];
    if (headerB64) {
        try {
            var b64 = headerB64.replace(/-/g, '+').replace(/_/g, '/');
            var padLen = b64.length % 4;
            if (padLen === 2) b64 += '==';
            else if (padLen === 3) b64 += '=';
            var header = JSON.parse(Encoding.fromBase64(b64).toString());
            if (header.alg !== 'RSA-OAEP-256' || header.enc !== 'A256GCM') {
                Logger.error('decryptMLEPayload: unexpected JWE algorithms — alg=' + header.alg + ', enc=' + header.enc + '. Expected RSA-OAEP-256 + A256GCM per CyberSource webhook spec.');
                throw new Error('Unsupported JWE algorithms');
            }
        } catch (he) {
            if (he.message === 'Unsupported JWE algorithms') throw he;
            // Header parse failure — fall through; JWE.parse below will surface a clearer error.
        }
    }

    try {
        var jwe = JWE.parse(trimmed);
        jwe.decrypt(new KeyRef(alias));
        return jwe.getPayload();
    } catch (e) {
        Logger.error('decryptMLEPayload failed for alias "' + alias + '": ' + e.message + '. Verify the .p12 private key is uploaded under Administration > Operations > Private Keys and Certificates with this exact alias.');
        throw e;
    }
}

/**
 * Defensive Signature Validation
 */
function validateSignature(req, customObjectKey) {
    var digitalSignature = req.httpHeaders.get('v-c-signature');
    Logger.info('Validating signature for ' + customObjectKey);
    if (!digitalSignature || !req.body) return false;
    try {
        var signatureParts = digitalSignature.split(';');
        if (signatureParts.length < 3) return false;
        var ts = signatureParts[0].split('=')[1];
        var s = signatureParts[2].split('=')[1];
        if (Math.abs(Date.now() - parseInt(ts)) > 300000) return false;

        var obj = CustomObjectMgr.getCustomObject('CyberSource Webhook Subscription', customObjectKey);
        if (!obj || !obj.custom.SecurityKey) return false;

        var hmac = new Mac('HmacSHA256');
        var secret = Encoding.fromBase64(obj.custom.SecurityKey);

        // CyberSource signs `{timestamp}.{raw_body}`. The earlier 3-variant fallback
        // re-stringified parsed JSON, which can never byte-match the original payload.
        var regenerated = hmac.digest(new Bytes(ts + '.' + req.body, 'utf8'), secret);
        return regenerated.toString() === Encoding.fromBase64(s).toString();
    } catch (e) {
        Logger.error('Error in validateSignature: ' + e.message);
        return false;
    }
}

/**
 * Helper to decrypt payload if MLE is enabled
 */
function getDecryptedPayload(body) {
    var payload;
    try {
        payload = JSON.parse(body);
        var encryptedData = payload.encData || payload.encryptedRequest;
        if (encryptedData) {
            var decryptedString = decryptMLEPayload(encryptedData);
            payload = JSON.parse(decryptedString);
        }
    } catch (e) {
        if (body && body.split('.').length === 5) {
            try {
                var decryptedString = decryptMLEPayload(body);
                payload = JSON.parse(decryptedString);
            } catch (innerE) { throw innerE; }
        } else { throw e; }
    }
    return payload;
}

/**
 * Locate the order for an APM (payments.payments.updated) webhook. The APM payload carries no
 * order number — only reconciliationId (the original payment requestId). At checkout the APM order
 * stores that value on its payment transaction (transactionID and/or custom.reconciliationId), so
 * we scan the orders still awaiting confirmation — the only ones an APM status update can act on —
 * and match. Scoped to NOTCONFIRMED + non-failed/cancelled to keep the search bounded, mirroring
 * the DMOrderStatusUpdate cron.
 *
 * @param {string} reconciliationId APM reconciliationId (equals the original payment requestId)
 * @returns {dw.order.Order} the matching order, or null
 */
function findOrderByReconciliationId(reconciliationId) {
    if (!reconciliationId) return null;
    var Order = require('dw/order/Order');
    var orders = OrderMgr.searchOrders(
        'confirmationStatus = {0} AND status != {1} AND status != {2}',
        'creationDate desc',
        Order.CONFIRMATION_STATUS_NOTCONFIRMED, Order.ORDER_STATUS_FAILED, Order.ORDER_STATUS_CANCELLED
    );
    try {
        while (orders.hasNext()) {
            var order = orders.next();
            var pis = order.getPaymentInstruments().toArray();
            for (var i = 0; i < pis.length; i++) {
                var pt = pis[i].paymentTransaction;
                if (!pt) continue; // eslint-disable-line no-continue
                var matchesTxn = pt.transactionID === reconciliationId;
                var matchesRecon = ('reconciliationId' in pt.custom) && pt.custom.reconciliationId === reconciliationId;
                if (matchesTxn || matchesRecon) return order;
            }
        }
    } finally {
        orders.close();
    }
    return null;
}

/**
 * Handle an Alternative Payment Methods status update (payments.payments.updated) — e.g. a PPRO
 * bank transfer or eCheck moving from PENDING to COMPLETED. APMs settle immediately (no separate
 * authorization to reverse), so a terminal success confirms the order and marks it PAID, while a
 * terminal failure fails it. Matched to the order via reconciliationId. Best-effort: always ack so
 * CyberSource does not keep retrying a notification we cannot act on.
 *
 * @param {Object} payload decoded webhook payload
 * @param {Object} res response object
 * @param {Function} next route next()
 * @returns {void}
 */
function handleApmPaymentUpdate(payload, res, next) {
    var apm = payload.payload || {};
    var reconciliationId = apm.reconciliationId;
    var status = apm.status;
    if (!reconciliationId) {
        Logger.error('apmNotification: missing reconciliationId; cannot match an order.');
        res.setStatusCode(200);
        res.json({ success: false });
        return next();
    }

    var order = findOrderByReconciliationId(reconciliationId);
    if (!order) {
        // Either already confirmed (out of the NOTCONFIRMED scan) or unknown — nothing to act on.
        // Ack so CyberSource stops retrying rather than looping on a no-op.
        Logger.warn('apmNotification: no NOTCONFIRMED order for reconciliationId ' + reconciliationId + ' (status ' + status + '); acknowledging.');
        res.setStatusCode(200);
        res.json({ success: true });
        return next();
    }

    var orderId = order.orderNo;
    var SUCCESS = ['COMPLETED', 'SETTLED'];
    var FAILURE = ['DECLINED', 'FAILED', 'CANCELLED', 'VOIDED'];
    Transaction.wrap(function () {
        if (SUCCESS.indexOf(status) > -1) {
            if (order.getConfirmationStatus() !== order.CONFIRMATION_STATUS_CONFIRMED) {
                order.setConfirmationStatus(order.CONFIRMATION_STATUS_CONFIRMED);
            }
            order.setPaymentStatus(order.PAYMENT_STATUS_PAID);
            Logger.info('apmNotification: Order ( ' + orderId + ' ) confirmed + marked PAID on APM ' + status + ' (reconciliationId ' + reconciliationId + ').');
        } else if (FAILURE.indexOf(status) > -1) {
            OrderMgr.failOrder(order, false);
            Logger.info('apmNotification: Order ( ' + orderId + ' ) failed on APM ' + status + ' (reconciliationId ' + reconciliationId + ').');
        } else {
            Logger.info('apmNotification: Order ( ' + orderId + ' ) APM status ' + status + ' is non-terminal; no order change (reconciliationId ' + reconciliationId + ').');
        }
    });

    res.setStatusCode(200);
    res.json({ success: true });
    return next();
}

function handleDmNotification(req, res, next) {
    if (req.httpMethod === 'GET') {
        res.json({ success: true });
        return next();
    }
    if (!validateSignature(req, 'fraudManagement')) {
        res.setStatusCode(401);
        res.json({ success: false });
        return next();
    }

    try {
        var payload = getDecryptedPayload(req.body);
        if (!payload) throw new Error('Decrypted payload is empty');

        // Normalize the DM/FM payload to its detail object. Case-management notifications nest the
        // data under payload.payload.data (an object); other shapes use transactionResult.details
        // or an array entry.
        var details = (payload.payload && payload.payload.transactionResult) ? payload.payload.transactionResult.details :
            (payload.payload && payload.payload.length ? payload.payload[0].data :
                (payload.payload && payload.payload.data ? payload.payload.data : payload));

        // The case-management payload carries the SFCC order number as referenceNumber (the merchant
        // reference number); other shapes use clientReferenceInformation.code. Prefer the latter, fall
        // back to referenceNumber so accept/reject and capture all resolve the order.
        var orderId = (details && details.clientReferenceInformation ? details.clientReferenceInformation.code : null)
            || (details ? details.referenceNumber : null);
        if (!orderId) throw new Error('Missing Order ID');

        var order = OrderMgr.getOrder(orderId);
        if (!order) {
            res.setStatusCode(503);
            res.json({ success: false, message: 'Order not found, retrying...' });
            return next();
        }

        var reversal = null;
        Transaction.wrap(function () {
            var eventType = payload.eventType || (payload.payload && payload.payload[0] ? payload.payload[0].eventType : null);
            if (eventType === 'risk.casemanagement.decision.accept') {
                // Replicates DMOrderStatusUpdate.js cron behavior on ACCEPT.
                OrderMgr.placeOrder(order);
                order.setConfirmationStatus(order.CONFIRMATION_STATUS_CONFIRMED);
                Logger.info('dmNotification: Order ( ' + orderId + ' ) successfully placed via case-management ACCEPT');
            } else if (eventType === 'risk.casemanagement.decision.reject') {
                // Replicates DMOrderStatusUpdate.js cron behavior on REJECT.
                // Case-management decisions carry the reviewer's reason in notes[0].comment
                // (no reviewerComments field); fall back to it so the cancel reason is captured.
                var reviewerComment = (details && details.riskInformation && details.riskInformation.reviewerComments)
                    || (details && details.reviewerComments)
                    || (details && Array.isArray(details.notes) && details.notes.length ? details.notes[0].comment : '')
                    || '';
                // Capture the authorization transaction id (set at auth time) BEFORE failing the
                // order, so the auth-only hold can be reversed once the transaction commits.
                var pis = order.getPaymentInstruments().toArray();
                for (var pIdx = 0; pIdx < pis.length; pIdx++) {
                    if (pis[pIdx].paymentTransaction && pis[pIdx].paymentTransaction.transactionID) {
                        reversal = {
                            requestId: pis[pIdx].paymentTransaction.transactionID,
                            total: order.totalGrossPrice.value,
                            currency: order.currencyCode
                        };
                        break;
                    }
                }
                OrderMgr.failOrder(order, false);
                order.cancelDescription = reviewerComment;
                Logger.info('dmNotification: Order ( ' + orderId + ' ) canceled via case-management REJECT');
            }
        });

        // Capture handling: when the merchant captures in EBC, the case-management notification
        // includes an _embedded.capture link but no captured amount. Fetch the amount via the
        // transaction-details API and reflect Captured / Partially Captured + AmountPaid + paymentStatus.
        var capture = details && details._embedded ? details._embedded.capture : null;
        if (capture) {
            try {
                var captureHref = capture._links && capture._links.self ? capture._links.self.href : null;
                var captureId = captureHref ? captureHref.substring(captureHref.lastIndexOf('/') + 1) : null;
                if (captureId) {
                    var dmStatusHelper = require('*/cartridge/scripts/helpers/webhookOrderStatusHelper');
                    var dmTransactionDetails = require('*/cartridge/scripts/http/transactionDetails');
                    var captureOutcome = dmStatusHelper.applyTransactionOutcome({
                        eventType: payload.eventType,
                        details: details,
                        transactionId: captureId,
                        order: order,
                        fetchCapturedAmount: dmTransactionDetails.getCapturedAmount
                    });
                    Logger.info('dmNotification: capture handled for order ( ' + orderId + ' ) captureId=' + captureId + ' -> status=' + captureOutcome.status + ' (applied=' + captureOutcome.applied + ')');
                } else {
                    Logger.error('dmNotification: capture present for order ( ' + orderId + ' ) but no capture id in href; cannot fetch amount.');
                }
            } catch (captureErr) {
                Logger.error('dmNotification: capture handling failed for order ( ' + orderId + ' ): ' + captureErr.message);
            }
        }

        // Reviewed orders are auth-only (capture is deferred until ACCEPT), so a REJECT must
        // release the authorization hold. The gateway call is made outside the DB transaction and
        // is best-effort — if the auth was already reversed/expired, log it and still ack the
        // webhook so CyberSource does not keep retrying.
        if (reversal) {
            try {
                require('~/cartridge/scripts/http/authReversal').httpAuthReversal(reversal.requestId, orderId, reversal.total, reversal.currency);
                Logger.info('dmNotification: auth reversal requested for rejected order ( ' + orderId + ' ), requestId ' + reversal.requestId);
            } catch (revErr) {
                Logger.error('dmNotification: auth reversal failed for rejected order ( ' + orderId + ' ): ' + (revErr && revErr.message ? revErr.message : revErr));
            }
        }

        
        
        res.setStatusCode(200);
        res.json({ success: true });
    } catch (e) {
        Logger.error('dmNotification error: ' + e.message);
        res.setStatusCode(200);
        res.json({ success: false });
    }
    return next();
}

// DM Notifications
server.use('dmNotification', handleDmNotification);
server.use('novusDmNotification', handleDmNotification);
server.use('tokenUpdate', function(req, res, next){
    res.json({ success: true });
        return next();
});
// APM (Unified Checkout) Notifications
//
// Architecture: the UC API *response* (handled inline at checkout) is the
// primary source of truth for order placement and confirmation status. This
// webhook is intentionally secondary — it serves two purposes only:
//
//   1. Enrichment: log additional transactional info (final settlement
//      status, risk decisions, network token info) that wasn't in the
//      synchronous response.
//   2. Safety net: if the response handler never reached the order (e.g.
//      browser closed mid-flow), stage the payload under
//      `CybersourceWebhookStaging` so a manual / cron reconciliation can
//      pick it up. The CyberSource retry policy gives us up to 3 deliveries.
//
// Important: the webhook MUST NOT downgrade an already-confirmed order back
// to NOTCONFIRMED. A late-arriving AUTHORIZED_PENDING_REVIEW for an order the
// response already confirmed is normal (review can clear after auth).
server.use('paymentNotification', function (req, res, next) {
    if (req.httpMethod === 'GET') {
        res.json({ success: true });
        return next();
    }

    if (!validateSignature(req, 'unifiedCheckout')) {
        Logger.error('paymentNotification: Signature validation failed');
        res.setStatusCode(401);
        res.json({ success: false });
        return next();
    }

    try {
        var payload = getDecryptedPayload(req.body);
        if (!payload) throw new Error('Decrypted payload is empty');

        // alternativePaymentMethods rides on this same subscription/endpoint; route it by eventType.
        var apmEventType = payload.eventType || (payload.payload && payload.payload[0] ? payload.payload[0].eventType : null);
        if (apmEventType === 'payments.payments.updated') {
            return handleApmPaymentUpdate(payload, res, next);
        }

        var details = (payload.payload && payload.payload.transactionResult) ? payload.payload.transactionResult.details :
            (payload.payload && payload.payload.length ? payload.payload[0].data : payload);

        var orderId = details && details.clientReferenceInformation ? details.clientReferenceInformation.code : null;
        if (!orderId) throw new Error('Missing Order ID');

        var order = OrderMgr.getOrder(orderId);

        if (!order) {
            var retryCount = parseInt(payload.retryNumber || (req.httpHeaders.containsKey('v-c-retry-count') ? req.httpHeaders.get('v-c-retry-count') : 0), 10) || 0;

            Transaction.wrap(function () {
                var stagingObj = CustomObjectMgr.getCustomObject('VisaAcceptanceWebhookStaging', orderId) || CustomObjectMgr.createCustomObject('VisaAcceptanceWebhookStaging', orderId);

                if (retryCount >= 2) {
                    Logger.error('paymentNotification: CRITICAL - FINAL RETRY FAILED. Failed to create order ' + orderId + ' after all webhook retries. This is definitively an orphaned authorization.');
                } else if (stagingObj.custom.payload) {
                    Logger.warn('paymentNotification: Order ' + orderId + ' STILL not found on webhook retry (' + retryCount + '/3). Overwriting staged payload.');
                } else {
                    Logger.info('paymentNotification: Order ' + orderId + ' not found on initial delivery. Staging payload.');
                }
                stagingObj.custom.payload = JSON.stringify(payload);
            });

            if (retryCount >= 2) {
                res.setStatusCode(200);
                res.json({ success: true, message: 'Final retry acknowledged. Orphaned authorization staged.' });
            } else {
                res.setStatusCode(503);
                res.json({ success: false, message: 'Order not yet created. Payload staged. Requesting retry as safety net.' });
            }
            return next();
        }

        // Enrichment logging — additional transactional info beyond what the
        // synchronous UC response carried. Keep this lightweight; deeper
        // persistence (e.g. order custom attrs) is left to merchant overrides.
        var enrichment = {
            orderId: orderId,
            status: details && details.status,
            id: details && details.id,
            reconciliationId: details && details.reconciliationId,
            riskDecision: details && details.riskInformation && details.riskInformation.providers
                ? details.riskInformation.providers.decision : undefined,
            networkTokenState: details && details.tokenInformation && details.tokenInformation.networkTokenOption
                ? details.tokenInformation.networkTokenOption.state : undefined
        };
        Logger.info('paymentNotification enrichment for ' + orderId + ': ' + JSON.stringify(enrichment));

        Transaction.wrap(function () {
            // Response is primary for confirmation status. Only *promote* an
            // unconfirmed order to CONFIRMED here as a safety net; never
            // demote a confirmed order back to NOTCONFIRMED.
            var currentStatus = order.getConfirmationStatus();
            if (currentStatus !== order.CONFIRMATION_STATUS_CONFIRMED &&
                ['COMPLETED', 'SETTLED', 'AUTHORIZED'].indexOf(details.status) > -1) {
                order.setConfirmationStatus(order.CONFIRMATION_STATUS_CONFIRMED);
                Logger.info('paymentNotification: Promoted order ' + orderId + ' to CONFIRMED via webhook safety net (response handler must have missed it).');
            }

            var stagingObj = CustomObjectMgr.getCustomObject('VisaAcceptanceWebhookStaging', orderId);
            if (stagingObj) CustomObjectMgr.remove(stagingObj);
        });

        // Reflect the transaction's auth/capture status in BM via the shared status helper.
        try {
            var ucStatusHelper = require('*/cartridge/scripts/helpers/webhookOrderStatusHelper');
            var ucTransactionDetails = require('*/cartridge/scripts/http/transactionDetails');
            ucStatusHelper.applyTransactionOutcome({
                eventType: payload.eventType || 'uc.orders.transactionresults',
                details: details,
                transactionId: details && details.id ? details.id : null,
                order: order,
                fetchCapturedAmount: ucTransactionDetails.getCapturedAmount
            });
        } catch (statusErr) {
            Logger.error('paymentNotification: status helper failed for ' + orderId + ': ' + statusErr.message);
        }

        res.setStatusCode(200);
        res.json({ success: true });
    } catch (e) {
        Logger.error('paymentNotification error: ' + e.message);
        res.setStatusCode(200);
        res.json({ success: false });
    }
    return next();
});


module.exports = server.exports();
